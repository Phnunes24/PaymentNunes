import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

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
      nome text not null unique,
      valor numeric(12, 2) not null default 0,
      dia_vencimento int,
      tipo text not null default 'fixa',
      ativo boolean not null default true,
      ordem int not null default 0
    )
  `;

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

  const [{ total }] = (await sql`select count(*)::int as total from contas`) as Array<{
    total: number;
  }>;

  if (total === 0) {
    for (let i = 0; i < SEED.length; i++) {
      const [nome, valor, tipo, secao] = SEED[i];
      await sql`
        insert into contas (nome, valor, tipo, secao, ordem)
        values (${nome}, ${valor}, ${tipo}, ${secao}, ${i})
        on conflict (nome) do nothing
      `;
    }
  }
}
