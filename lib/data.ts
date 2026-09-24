import { db, ensureSchema } from "./db";
import { hoje } from "./format";

export type Conta = {
  id: number;
  nome: string;
  valor: number;
  dia_vencimento: number | null;
  tipo: "fixa" | "cartao";
  ordem: number;
};

export type Status = "pago" | "atrasado" | "aberto";

export type LinhaMes = {
  conta_id: number;
  nome: string;
  tipo: "fixa" | "cartao";
  dia_vencimento: number | null;
  vencimento: string | null;
  previsto: number;
  pago: boolean;
  valor_pago: number | null;
  data_pgto: string | null;
  pagoEfetivo: number;
  status: Status;
};

export type Gasto = {
  id: number;
  data: string;
  descricao: string;
  categoria: string;
  pago_com: string;
  valor: number;
};

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
  await sql`
    insert into contas_mes (ano, mes, conta_id, previsto)
    select ${ano}, ${mes}, c.id,
           case when c.tipo = 'cartao' then 0 else c.valor end
      from contas c
     where c.ativo
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
    select id, nome, valor, dia_vencimento, tipo, ordem
      from contas
     where ativo
     order by ordem, id
  `) as Array<Record<string, unknown>>;
  return linhas.map((l) => ({
    id: num(l.id),
    nome: String(l.nome),
    valor: num(l.valor),
    dia_vencimento: l.dia_vencimento == null ? null : num(l.dia_vencimento),
    tipo: l.tipo === "cartao" ? "cartao" : "fixa",
    ordem: num(l.ordem),
  }));
}

/** Soma dos gastos do mes agrupada por forma de pagamento. E o que forma a
 *  fatura de cada cartao, sem ninguem digitar o total. */
export async function faturasDoMes(
  ano: number,
  mes: number
): Promise<Map<string, number>> {
  const sql = db();
  const linhas = (await sql`
    select pago_com, sum(valor) as total
      from gastos
     where extract(year from data) = ${ano}
       and extract(month from data) = ${mes}
     group by pago_com
  `) as Array<Record<string, unknown>>;
  const mapa = new Map<string, number>();
  for (const l of linhas) mapa.set(String(l.pago_com), num(l.total));
  return mapa;
}

export async function contasDoMes(ano: number, mes: number): Promise<LinhaMes[]> {
  await abrirMes(ano, mes);
  const sql = db();

  const [linhas, faturas] = await Promise.all([
    sql`
      select c.id   as conta_id,
             c.nome, c.tipo, c.dia_vencimento,
             m.previsto, m.pago, m.valor_pago, m.data_pgto
        from contas_mes m
        join contas c on c.id = m.conta_id
       where m.ano = ${ano} and m.mes = ${mes} and c.ativo
       order by c.ordem, c.id
    ` as Promise<Array<Record<string, unknown>>>,
    faturasDoMes(ano, mes),
  ]);

  const hojeIso = hoje().iso;

  return linhas.map((l) => {
    const tipo = l.tipo === "cartao" ? "cartao" : "fixa";
    const nome = String(l.nome);
    const previsto =
      tipo === "cartao" ? (faturas.get(nome) ?? 0) : num(l.previsto);
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

    return {
      conta_id: num(l.conta_id),
      nome,
      tipo,
      dia_vencimento: dia,
      vencimento,
      previsto,
      pago,
      valor_pago: valorPago,
      data_pgto: iso(l.data_pgto),
      pagoEfetivo: pago ? (valorPago ?? previsto) : 0,
      status,
    };
  });
}

export async function gastosDoMes(ano: number, mes: number): Promise<Gasto[]> {
  await ensureSchema();
  const sql = db();
  const linhas = (await sql`
    select id, data, descricao, categoria, pago_com, valor
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
  }));
}

export function porCategoria(gastos: Gasto[]): Array<[string, number]> {
  const mapa = new Map<string, number>();
  for (const g of gastos) {
    mapa.set(g.categoria, (mapa.get(g.categoria) ?? 0) + g.valor);
  }
  return [...mapa.entries()].sort((a, b) => b[1] - a[1]);
}
