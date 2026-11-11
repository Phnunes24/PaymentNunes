import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { hoje } from "./format";

let client: NeonQueryFunction<false, false> | null = null;

/** Conexao com o Postgres. So e criada quando alguma query roda, para o
 *  build nao quebrar quando a variavel ainda nao existe. */
export function db(): NeonQueryFunction<false, false> {
  if (!client) {
    const url =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL;
    if (!url) {
      throw new Error(
        "Falta a variavel DATABASE_URL. Crie o banco Postgres no painel do Vercel e conecte ao projeto."
      );
    }
    client = neon(url);
  }
  return client;
}

/** As contas que ja vao existir no primeiro acesso: nome, valor, tipo, secao. */
const SEED: Array<[string, number, string, string]> = [
  ["Carro", 1326.74, "fixa", "Transporte"],
  ["Vaga", 200, "fixa", "Transporte"],
  ["Faculdade", 356, "fixa", "Estudos"],
  ["Imposto", 180, "fixa", "Empresa"],
  ["Contador", 250, "fixa", "Empresa"],
  ["Cartao Nubank", 0, "cartao", "Cartoes"],
  ["Cartao Bradesco Empresa", 0, "cartao", "Cartoes"],
];

/** Renda que ja vai estar preenchida no primeiro acesso. Depois disso ela se
 *  muda pela propria pagina, mes a mes. */
const RENDA_INICIAL = 4300;

let pronto: Promise<void> | null = null;

/** Cria as tabelas e semeia as contas na primeira vez. Roda uma vez por
 *  instancia; as instrucoes sao todas idempotentes. */
export function ensureSchema(): Promise<void> {
  if (!pronto) pronto = criar();
  return pronto;
}

async function criar(): Promise<void> {
  const sql = db();

  await sql`
    create table if not exists contas (
      id serial primary key,
      nome text not null,
      valor numeric(12, 2) not null default 0,
      dia_vencimento int,
      tipo text not null default 'fixa',
      ativo boolean not null default true,
      ordem int not null default 0
    )
  `;

  // Nome unico so entre as contas ativas: uma conta apagada continua no
  // historico dos meses pagos sem impedir que outra nasca com o mesmo nome.
  // Bancos antigos tem a restricao de nome unico em tudo; ela sai uma vez.
  const [{ tem: temUnicoAntigo }] = (await sql`
    select count(*)::int as tem from pg_constraint where conname = 'contas_nome_key'
  `) as Array<{ tem: number }>;

  if (temUnicoAntigo > 0) {
    await sql`alter table contas drop constraint contas_nome_key`;
  }
  await sql`
    create unique index if not exists contas_nome_ativa_idx
        on contas (nome) where ativo
  `;

  // Conta com numero certo de parcelas (financiamento, curso): quantas sao no
  // total e em que mes caiu a primeira, guardado como ano * 12 + mes. Sem
  // isso a conta se repete todo mes, sem fim.
  await sql`alter table contas add column if not exists parcelas int`;
  await sql`alter table contas add column if not exists parcela_inicio int`;

  // Cartao: dia em que a fatura fecha. Com ele, a compra cai na fatura do
  // mes em que e paga, e nao no mes em que foi feita.
  await sql`alter table contas add column if not exists dia_fechamento int`;

  await sql`
    create table if not exists contas_mes (
      id serial primary key,
      ano int not null,
      mes int not null,
      conta_id int not null references contas (id) on delete cascade,
      previsto numeric(12, 2) not null default 0,
      pago boolean not null default false,
      valor_pago numeric(12, 2),
      data_pgto date,
      unique (ano, mes, conta_id)
    )
  `;

  await sql`
    create table if not exists gastos (
      id serial primary key,
      data date not null,
      descricao text not null,
      categoria text not null default 'Outros',
      pago_com text not null default 'Pix',
      valor numeric(12, 2) not null,
      criado_em timestamptz not null default now()
    )
  `;

  await sql`create index if not exists gastos_data_idx on gastos (data)`;

  // De onde o gasto veio (manual, apple-pay, banco) e, quando veio do banco,
  // o identificador da transacao, que impede lancar a mesma compra duas vezes.
  const [{ tem: temOrigem }] = (await sql`
    select count(*)::int as tem
      from information_schema.columns
     where table_name = 'gastos' and column_name = 'origem'
  `) as Array<{ tem: number }>;

  if (temOrigem === 0) {
    await sql`alter table gastos add column origem text not null default 'manual'`;
    await sql`alter table gastos add column if not exists externo text`;
  }
  await sql`
    create unique index if not exists gastos_externo_idx
        on gastos (externo) where externo is not null
  `;

  // Fatura em que a compra cai (ano * 12 + mes do vencimento), quando o banco
  // informa. Vazio, vale a regra do fechamento do cartao.
  await sql`alter table gastos add column if not exists fatura int`;

  // Investimentos lidos do banco na ultima sincronizacao, e um retrato por dia
  // do total investido e do saldo em conta, para acompanhar a evolucao.
  await sql`
    create table if not exists investimentos (
      id text primary key,
      item text not null,
      banco text not null,
      nome text not null,
      tipo text not null,
      subtipo text,
      situacao text,
      saldo numeric(14, 2) not null default 0,
      bruto numeric(14, 2),
      aplicado numeric(14, 2),
      lucro numeric(14, 2),
      taxa numeric(10, 4),
      indexador text,
      taxa_fixa numeric(10, 4),
      vencimento date,
      emissor text,
      atualizado timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists patrimonio (
      data date primary key,
      investido numeric(14, 2) not null default 0,
      em_conta numeric(14, 2) not null default 0
    )
  `;

  // Chaves e estado da importacao dos bancos, e outras configuracoes soltas.
  await sql`
    create table if not exists config (
      chave text primary key,
      valor text not null
    )
  `;

  // Teto de gasto por categoria no mes. Opcional: categoria sem linha aqui
  // nao tem limite.
  await sql`
    create table if not exists limites (
      categoria text primary key,
      valor numeric(12, 2) not null
    )
  `;

  // Toda transacao de banco ja vista, lancada ou ignorada. E o que impede um
  // gasto que voce apagou de voltar na proxima sincronizacao.
  await sql`
    create table if not exists importados (
      chave text primary key,
      acao text not null,
      descricao text,
      valor numeric(12, 2),
      data date,
      criado_em timestamptz not null default now()
    )
  `;

  // Quanto entra no mes. Uma linha por mes, e o mes sem linha propria herda a
  // ultima renda cadastrada antes dele.
  await sql`
    create table if not exists renda (
      id serial primary key,
      ano int not null,
      mes int not null,
      valor numeric(12, 2) not null default 0,
      unique (ano, mes)
    )
  `;

  // A coluna de secao veio depois. Quando ela ainda nao existe, criamos e
  // distribuimos as contas antigas pelas secoes de origem uma unica vez.
  const [{ tem }] = (await sql`
    select count(*)::int as tem
      from information_schema.columns
     where table_name = 'contas' and column_name = 'secao'
  `) as Array<{ tem: number }>;

  if (tem === 0) {
    await sql`alter table contas add column secao text not null default 'Geral'`;
    for (const [nome, , , secao] of SEED) {
      await sql`update contas set secao = ${secao} where nome = ${nome}`;
    }
  }

  // Marca que o previsto daquele mes foi digitado a mao. Para um cartao, e o
  // que faz o valor parar de ser a soma dos gastos e passar a ser o que voce
  // escreveu.
  const [{ tem: temManual }] = (await sql`
    select count(*)::int as tem
      from information_schema.columns
     where table_name = 'contas_mes' and column_name = 'previsto_manual'
  `) as Array<{ tem: number }>;

  if (temManual === 0) {
    await sql`
      alter table contas_mes
        add column previsto_manual boolean not null default false
    `;
  }

  const [{ total: temRenda }] = (await sql`
    select count(*)::int as total from renda
  `) as Array<{ total: number }>;

  if (temRenda === 0) {
    const { ano, mes } = hoje();
    await sql`
      insert into renda (ano, mes, valor)
      values (${ano}, ${mes}, ${RENDA_INICIAL})
      on conflict (ano, mes) do nothing
    `;
  }

  const [{ total }] = (await sql`select count(*)::int as total from contas`) as Array<{
    total: number;
  }>;

  if (total === 0) {
    for (let i = 0; i < SEED.length; i++) {
      const [nome, valor, tipo, secao] = SEED[i];
      await sql`
        insert into contas (nome, valor, tipo, secao, ordem)
        values (${nome}, ${valor}, ${tipo}, ${secao}, ${i})
        on conflict do nothing
      `;
    }
  }
}
