import { db, ensureSchema } from "./db";
import { hoje } from "./format";
import { faturaDaCompra, mesDoIndice } from "./resumo";

export type Conta = {
  id: number;
  nome: string;
  valor: number;
  dia_vencimento: number | null;
  tipo: "fixa" | "cartao";
  secao: string;
  ordem: number;
  /** Total de parcelas, ou null quando a conta nao tem fim. */
  parcelas: number | null;
  /** Mes da primeira parcela, como ano * 12 + mes. */
  parcela_inicio: number | null;
  /** Cartao: dia em que a fatura fecha (31 = ultimo dia do mes). */
  dia_fechamento: number | null;
};

export type Status = "pago" | "atrasado" | "aberto";

export type LinhaMes = {
  conta_id: number;
  nome: string;
  tipo: "fixa" | "cartao";
  secao: string;
  dia_vencimento: number | null;
  vencimento: string | null;
  previsto: number;
  previstoManual: boolean;
  pago: boolean;
  valor_pago: number | null;
  data_pgto: string | null;
  pagoEfetivo: number;
  status: Status;
  /** Numero da parcela neste mes e total, quando a conta e parcelada. */
  parcela: number | null;
  parcelas: number | null;
};

export type Gasto = {
  id: number;
  data: string;
  descricao: string;
  categoria: string;
  pago_com: string;
  valor: number;
  /** manual, apple-pay ou banco */
  origem: string;
  /** Fatura em que a compra cai (ano * 12 + mes), quando o banco informou. */
  fatura: number | null;
};

/** Quando a fatura de um cartao fecha e vence. */
export type Ciclo = { fechamento: number | null; vencimento: number | null };

export const CATEGORIAS = [
  "Mercado",
  "Alimentação",
  "Combustível",
  "Transporte",
  "Casa",
  "Saúde",
  "Lazer",
  "Assinaturas",
  "Trabalho",
  "Outros",
];

export const FORMAS_EXTRA = ["Pix", "Débito", "Dinheiro", "Boleto"];

/** O que da para mudar numa conta. */
export type DadosConta = {
  nome: string;
  secao: string;
  tipo: "fixa" | "cartao";
  valor: number;
  dia_vencimento: number | null;
  /** Total de parcelas (null = sem fim) e mes da primeira (ano * 12 + mes). */
  parcelas?: number | null;
  parcela_inicio?: number | null;
  /** Cartao: dia em que a fatura fecha. */
  dia_fechamento?: number | null;
};

/** O que da para mudar num gasto ja lancado. */
export type DadosGasto = {
  descricao: string;
  valor: number;
  data: string;
  categoria: string;
  pago_com: string;
};

/** Dia de fechamento so existe em cartao, e entre 1 e 31. */
function fechamentoDe(d: DadosConta): number | null {
  const dia = d.dia_fechamento ?? null;
  return d.tipo === "cartao" && dia != null && dia >= 1 && dia <= 31 ? dia : null;
}

/** Parcelas so valem com total e mes de inicio juntos, e nunca em cartao. */
function parcelasDe(d: DadosConta): { total: number | null; inicio: number | null } {
  const total = d.parcelas ?? null;
  const inicio = d.parcela_inicio ?? null;
  if (d.tipo === "cartao" || total == null || inicio == null || total < 1) {
    return { total: null, inicio: null };
  }
  return { total, inicio };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(valor: unknown): string | null {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function diasNoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/** Cria as linhas do mes que ainda nao existem. E isto que faz o mes novo
 *  "abrir sozinho": na primeira visita (ou no cron do dia 1) as contas do
 *  mes aparecem prontas. */
export async function abrirMes(ano: number, mes: number): Promise<void> {
  await ensureSchema();
  const sql = db();
  // Conta parcelada so entra nos meses que tem parcela: nem antes da
  // primeira, nem depois da ultima.
  const indice = ano * 12 + mes;
  await sql`
    insert into contas_mes (ano, mes, conta_id, previsto)
    select ${ano}, ${mes}, c.id,
           case when c.tipo = 'cartao' then 0 else c.valor end
      from contas c
     where c.ativo
       and (c.parcelas is null or c.parcela_inicio is null
            or ${indice}::int - c.parcela_inicio + 1 between 1 and c.parcelas)
       and not exists (
             select 1 from contas_mes m
              where m.ano = ${ano} and m.mes = ${mes} and m.conta_id = c.id
           )
  `;
}

export async function listarContas(): Promise<Conta[]> {
  await ensureSchema();
  const sql = db();
  const linhas = (await sql`
    select id, nome, valor, dia_vencimento, tipo, secao, ordem,
           parcelas, parcela_inicio, dia_fechamento
      from contas
     where ativo
     order by secao, ordem, id
  `) as Array<Record<string, unknown>>;
  return linhas.map((l) => ({
    id: num(l.id),
    nome: String(l.nome),
    valor: num(l.valor),
    dia_vencimento: l.dia_vencimento == null ? null : num(l.dia_vencimento),
    tipo: l.tipo === "cartao" ? "cartao" : "fixa",
    secao: String(l.secao ?? "Geral"),
    ordem: num(l.ordem),
    parcelas: l.parcelas == null ? null : num(l.parcelas),
    parcela_inicio: l.parcela_inicio == null ? null : num(l.parcela_inicio),
    dia_fechamento: l.dia_fechamento == null ? null : num(l.dia_fechamento),
  }));
}

/** Ja existe outra conta ativa com esse nome? Maiuscula nao conta. */
async function nomeEmUso(nome: string, exceto: number): Promise<boolean> {
  const sql = db();
  const achou = (await sql`
    select 1 from contas
     where ativo and lower(nome) = lower(${nome}) and id <> ${exceto}
     limit 1
  `) as unknown[];
  return achou.length > 0;
}

/** Cria uma conta nova. Ela aparece no mes que voce estiver vendo e nos
 *  proximos, porque cada mes se monta com as contas ativas do momento.
 *  Devolve false quando ja existe uma conta ativa com esse nome. */
export async function criarConta(d: DadosConta): Promise<boolean> {
  await ensureSchema();
  if (await nomeEmUso(d.nome, 0)) return false;
  const sql = db();
  const { total, inicio } = parcelasDe(d);
  await sql`
    insert into contas (nome, valor, dia_vencimento, tipo, secao, ordem,
                        parcelas, parcela_inicio, dia_fechamento)
    select ${d.nome}, ${d.tipo === "cartao" ? 0 : d.valor}, ${d.dia_vencimento},
           ${d.tipo}, ${d.secao}, coalesce(max(ordem), 0) + 1,
           ${total}::int, ${inicio}::int, ${fechamentoDe(d)}::int
      from contas
  `;
  return true;
}

/** Muda tudo de uma conta: nome, secao, tipo, valor e vencimento. O valor
 *  novo vale deste mes em diante, nos meses ainda nao pagos em que voce nao
 *  digitou um valor so daquele mes. Devolve false quando o nome novo ja e de
 *  outra conta ativa. */
export async function editarConta(id: number, d: DadosConta): Promise<boolean> {
  await ensureSchema();
  const sql = db();

  const [antes] = (await sql`
    select nome, tipo from contas where id = ${id} and ativo
  `) as Array<{ nome: string; tipo: string }>;
  if (!antes) return true;

  const nome = d.nome || antes.nome;
  if (nome !== antes.nome && (await nomeEmUso(nome, id))) return false;
  const valor = d.tipo === "cartao" ? 0 : d.valor;
  const { total, inicio } = parcelasDe(d);

  await sql`
    update contas
       set nome = ${nome}, secao = ${d.secao}, tipo = ${d.tipo},
           valor = ${valor}, dia_vencimento = ${d.dia_vencimento},
           parcelas = ${total}::int, parcela_inicio = ${inicio}::int,
           dia_fechamento = ${fechamentoDe(d)}::int
     where id = ${id}
  `;

  // Meses em aberto depois da ultima parcela deixam de existir.
  if (total != null && inicio != null) {
    await sql`
      delete from contas_mes
       where conta_id = ${id}
         and pago = false
         and ano * 12 + mes > ${inicio + total - 1}
    `;
  }

  // A fatura do cartao e achada pelo nome gravado em cada gasto. Renomeou o
  // cartao, os gastos vao junto, inclusive os dos meses passados.
  if (antes.tipo === "cartao" && nome !== antes.nome) {
    await sql`update gastos set pago_com = ${nome} where pago_com = ${antes.nome}`;
  }

  // Trocou de tipo, o valor digitado a mao num mes deixa de fazer sentido:
  // volta tudo para o automatico.
  const mudouTipo = d.tipo !== antes.tipo;
  const { ano, mes } = hoje();
  await sql`
    update contas_mes
       set previsto = ${valor}, previsto_manual = false
     where conta_id = ${id}
       and pago = false
       and ano * 12 + mes >= ${ano * 12 + mes}
       and (${mudouTipo}::boolean or previsto_manual = false)
  `;
  return true;
}

/** Apaga a conta deste mes em diante. Os meses anteriores em que ela foi
 *  paga continuam no historico; se nao sobrar nenhum, ela some de vez. */
export async function apagarConta(id: number): Promise<void> {
  await ensureSchema();
  const sql = db();
  const { ano, mes } = hoje();
  await sql`update contas set ativo = false where id = ${id}`;
  await sql`
    delete from contas_mes
     where conta_id = ${id}
       and (pago = false or ano * 12 + mes >= ${ano * 12 + mes})
  `;
  await sql`
    delete from contas c
     where c.id = ${id}
       and not exists (select 1 from contas_mes m where m.conta_id = c.id)
  `;
}

/** Fechamento e vencimento de cada cartao, pelo nome. Entram os apagados
 *  tambem, por causa das faturas antigas; havendo dois com o mesmo nome,
 *  vale o ativo. */
export async function ciclosDosCartoes(): Promise<Map<string, Ciclo>> {
  const linhas = (await db()`
    select nome, dia_fechamento, dia_vencimento
      from contas
     where tipo = 'cartao'
     order by ativo, id
  `) as Array<Record<string, unknown>>;
  const ciclos = new Map<string, Ciclo>();
  for (const l of linhas) {
    ciclos.set(String(l.nome), {
      fechamento: l.dia_fechamento == null ? null : num(l.dia_fechamento),
      vencimento: l.dia_vencimento == null ? null : num(l.dia_vencimento),
    });
  }
  return ciclos;
}

/** Fatura em que um gasto cai (ano * 12 + mes), ou null se ele nao foi pago
 *  com cartao. O que o banco informou vale mais que a regra do fechamento. */
export function faturaDoGasto(
  g: Pick<Gasto, "data" | "pago_com" | "fatura">,
  ciclos: Map<string, Ciclo>
): number | null {
  const ciclo = ciclos.get(g.pago_com);
  if (!ciclo) return null;
  return g.fatura ?? faturaDaCompra(g.data, ciclo.fechamento, ciclo.vencimento);
}

/**
 * Fatura de cada cartao em cada mes do intervalo (indices ano * 12 + mes):
 * a soma das compras que caem naquela fatura. E o que forma a fatura sem
 * ninguem digitar o total.
 */
export async function faturasNoIntervalo(
  de: number,
  ate: number
): Promise<Map<number, Map<string, number>>> {
  const sql = db();
  // Compra de ate dois meses antes pode cair na fatura: feita depois do
  // fechamento, entra na que fecha no mes seguinte e vence no outro.
  const inicio = mesDoIndice(de - 2);
  const fim = mesDoIndice(ate + 1);
  const [ciclos, gastos] = await Promise.all([
    ciclosDosCartoes(),
    sql`
      select pago_com, data, valor, fatura
        from gastos
       where (fatura between ${de} and ${ate})
          or (fatura is null
              and data >= ${`${inicio.ano}-${pad(inicio.mes)}-01`}::date
              and data < ${`${fim.ano}-${pad(fim.mes)}-01`}::date)
    ` as Promise<Array<Record<string, unknown>>>,
  ]);

  const porMes = new Map<number, Map<string, number>>();
  for (const g of gastos) {
    const cartao = String(g.pago_com);
    const indice = faturaDoGasto(
      {
        data: iso(g.data) ?? "",
        pago_com: cartao,
        fatura: g.fatura == null ? null : num(g.fatura),
      },
      ciclos
    );
    if (indice == null || indice < de || indice > ate) continue;
    const doMes = porMes.get(indice) ?? new Map<string, number>();
    doMes.set(cartao, (doMes.get(cartao) ?? 0) + num(g.valor));
    porMes.set(indice, doMes);
  }
  return porMes;
}

export async function faturasDoMes(
  ano: number,
  mes: number
): Promise<Map<string, number>> {
  const indice = ano * 12 + mes;
  return (await faturasNoIntervalo(indice, indice)).get(indice) ?? new Map();
}

export async function contasDoMes(ano: number, mes: number): Promise<LinhaMes[]> {
  await abrirMes(ano, mes);
  const sql = db();

  const [linhas, faturas] = await Promise.all([
    sql`
      select c.id   as conta_id,
             c.nome, c.tipo, c.secao, c.dia_vencimento,
             c.parcelas, c.parcela_inicio,
             m.previsto, m.previsto_manual, m.pago, m.valor_pago, m.data_pgto
        from contas_mes m
        join contas c on c.id = m.conta_id
       where m.ano = ${ano} and m.mes = ${mes}
         and (c.ativo or m.pago)
       order by c.secao, c.ordem, c.id
    ` as Promise<Array<Record<string, unknown>>>,
    faturasDoMes(ano, mes),
  ]);

  const hojeIso = hoje().iso;

  return linhas.map((l) => {
    const tipo = l.tipo === "cartao" ? "cartao" : "fixa";
    const nome = String(l.nome);
    const manual = Boolean(l.previsto_manual);
    // Cartao sem valor digitado e a soma das compras que caem nesta fatura.
    // Assim que voce escreve um valor, passa a valer o que voce escreveu.
    const previsto =
      tipo === "cartao" && !manual ? (faturas.get(nome) ?? 0) : num(l.previsto);
    const pago = Boolean(l.pago);
    const valorPago = l.valor_pago == null ? null : num(l.valor_pago);
    const dia = l.dia_vencimento == null ? null : num(l.dia_vencimento);

    let vencimento: string | null = null;
    if (dia != null && dia >= 1) {
      const d = Math.min(dia, diasNoMes(ano, mes));
      vencimento = `${ano}-${pad(mes)}-${pad(d)}`;
    }

    let status: Status = "aberto";
    if (pago) status = "pago";
    else if (vencimento && vencimento < hojeIso) status = "atrasado";

    const total = l.parcelas == null ? null : num(l.parcelas);
    const inicio = l.parcela_inicio == null ? null : num(l.parcela_inicio);
    const numero =
      total != null && inicio != null ? ano * 12 + mes - inicio + 1 : null;
    const parcelada =
      numero != null && total != null && numero >= 1 && numero <= total;

    return {
      conta_id: num(l.conta_id),
      nome,
      tipo,
      secao: String(l.secao ?? "Geral"),
      dia_vencimento: dia,
      vencimento,
      previsto,
      previstoManual: manual,
      pago,
      valor_pago: valorPago,
      data_pgto: iso(l.data_pgto),
      pagoEfetivo: pago ? (valorPago ?? previsto) : 0,
      status,
      parcela: parcelada ? numero : null,
      parcelas: parcelada ? total : null,
    };
  });
}

/** Renda daquele mes. O mes que nunca teve valor digitado herda a ultima
 *  renda cadastrada antes dele, do mesmo jeito que o valor de uma conta fixa
 *  vale dali para a frente. Para um mes anterior a tudo que existe, vale a
 *  primeira renda cadastrada, senao o mes passado apareceria zerado. */
export async function rendaDoMes(ano: number, mes: number): Promise<number> {
  await ensureSchema();
  const sql = db();
  const alvo = ano * 12 + mes;

  const anteriores = (await sql`
    select valor
      from renda
     where ano * 12 + mes <= ${alvo}
     order by ano desc, mes desc
     limit 1
  `) as Array<Record<string, unknown>>;
  if (anteriores.length > 0) return num(anteriores[0].valor);

  const primeira = (await sql`
    select valor from renda order by ano, mes limit 1
  `) as Array<Record<string, unknown>>;
  return primeira.length > 0 ? num(primeira[0].valor) : 0;
}

export async function gastosDoMes(ano: number, mes: number): Promise<Gasto[]> {
  await ensureSchema();
  const sql = db();
  const linhas = (await sql`
    select id, data, descricao, categoria, pago_com, valor, origem, fatura
      from gastos
     where extract(year from data) = ${ano}
       and extract(month from data) = ${mes}
     order by data desc, id desc
  `) as Array<Record<string, unknown>>;
  return linhas.map((l) => ({
    id: num(l.id),
    data: iso(l.data) ?? "",
    descricao: String(l.descricao),
    categoria: String(l.categoria),
    pago_com: String(l.pago_com),
    valor: num(l.valor),
    origem: String(l.origem ?? "manual"),
    fatura: l.fatura == null ? null : num(l.fatura),
  }));
}

/** Agrupa as contas do mes por secao, preservando a ordem que veio do banco. */
export function porSecao(linhas: LinhaMes[]): Array<[string, LinhaMes[]]> {
  const mapa = new Map<string, LinhaMes[]>();
  for (const l of linhas) {
    const atual = mapa.get(l.secao);
    if (atual) atual.push(l);
    else mapa.set(l.secao, [l]);
  }
  return [...mapa.entries()];
}

export function porCategoria(gastos: Gasto[]): Array<[string, number]> {
  const mapa = new Map<string, number>();
  for (const g of gastos) {
    mapa.set(g.categoria, (mapa.get(g.categoria) ?? 0) + g.valor);
  }
  return [...mapa.entries()].sort((a, b) => b[1] - a[1]);
}

/** Corrige um gasto ja lancado: descricao, valor, data, categoria e forma. */
export async function editarGasto(id: number, d: DadosGasto): Promise<void> {
  await ensureSchema();
  await db()`
    update gastos
       set descricao = ${d.descricao}, valor = ${d.valor}, data = ${d.data},
           categoria = ${d.categoria}, pago_com = ${d.pago_com}
     where id = ${id}
  `;
}

/** Limite de gasto por categoria. So traz as categorias que tem limite. */
export async function lerLimites(): Promise<Map<string, number>> {
  await ensureSchema();
  const linhas = (await db()`
    select categoria, valor from limites
  `) as Array<Record<string, unknown>>;
  return new Map(linhas.map((l) => [String(l.categoria), num(l.valor)]));
}

/** Guarda os limites recebidos. Valor zero ou negativo tira o limite. */
export async function salvarLimites(limites: Map<string, number>): Promise<void> {
  await ensureSchema();
  const sql = db();
  for (const [categoria, valor] of limites) {
    if (valor > 0) {
      await sql`
        insert into limites (categoria, valor) values (${categoria}, ${valor})
        on conflict (categoria) do update set valor = excluded.valor
      `;
    } else {
      await sql`delete from limites where categoria = ${categoria}`;
    }
  }
}
