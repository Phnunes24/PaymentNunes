/**
 * Investimentos guardados na ultima sincronizacao com os bancos (lib/bancos.ts
 * grava; aqui so se le) e o retrato diario do patrimonio.
 */
import { db, ensureSchema } from "./db";

export type Investimento = {
  id: string;
  banco: string;
  nome: string;
  tipo: string;
  subtipo: string | null;
  /** Saldo liquido hoje. */
  saldo: number;
  aplicado: number | null;
  lucro: number | null;
  taxa: number | null;
  indexador: string | null;
  taxaFixa: number | null;
  vencimento: string | null;
  emissor: string | null;
};

export type Retrato = { data: string; investido: number; emConta: number };

export type Carteira = {
  /** Com saldo hoje, do maior para o menor. */
  ativos: Investimento[];
  /** Ja resgatados por inteiro. */
  encerrados: Investimento[];
  total: number;
  porTipo: Array<[string, number]>;
  porBanco: Array<[string, number]>;
  /** Saldo nas contas correntes, no ultimo retrato. */
  emConta: number;
  atualizado: string | null;
  /** Um ponto por dia de sincronizacao, do mais antigo para o mais novo. */
  historico: Retrato[];
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function opcional(v: unknown): number | null {
  return v == null ? null : num(v);
}

function iso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

const TIPOS: Record<string, string> = {
  FIXED_INCOME: "Renda fixa",
  EQUITY: "Ações",
  MUTUAL_FUND: "Fundos",
  SECURITY: "Previdência",
  ETF: "ETFs",
  COE: "COE",
  OTHER: "Outros",
};

const SUBTIPOS: Record<string, string> = {
  TREASURY: "Tesouro Direto",
  DEBENTURES: "Debênture",
  STOCK: "Ação",
  REAL_ESTATE_FUND: "Fundo imobiliário",
  FIXED_INCOME_FUND: "Fundo de renda fixa",
  MULTIMARKET_FUND: "Fundo multimercado",
  STOCK_FUND: "Fundo de ações",
  RETIREMENT: "Previdência",
};

/** "FIXED_INCOME" -> "Renda fixa". */
export function rotuloTipo(tipo: string): string {
  return TIPOS[tipo] ?? "Outros";
}

/** "CDB", "Tesouro Direto"; siglas ficam como vieram. */
export function rotuloSubtipo(subtipo: string | null): string | null {
  if (!subtipo) return null;
  return SUBTIPOS[subtipo] ?? subtipo.replace(/_/g, " ");
}

function porcento(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + "%";
}

/** Quanto rende, em palavras: "100% do CDI", "IPCA + 6% ao ano", "12,5% ao
 *  ano". Vazio quando o banco nao informa. */
export function rendimento(i: Pick<Investimento, "taxa" | "indexador" | "taxaFixa">): string {
  if (i.indexador && i.taxaFixa && (!i.taxa || i.taxa === 100)) {
    return `${i.indexador} + ${porcento(i.taxaFixa)} ao ano`;
  }
  if (i.indexador && i.taxa) return `${porcento(i.taxa)} do ${i.indexador}`;
  if (i.taxaFixa) return `${porcento(i.taxaFixa)} ao ano`;
  return "";
}

function somar(
  lista: Investimento[],
  chave: (i: Investimento) => string
): Array<[string, number]> {
  const mapa = new Map<string, number>();
  for (const i of lista) mapa.set(chave(i), (mapa.get(chave(i)) ?? 0) + i.saldo);
  return [...mapa.entries()]
    .map(([nome, valor]): [string, number] => [nome, Math.round(valor * 100) / 100])
    .sort((a, b) => b[1] - a[1]);
}

export async function lerCarteira(): Promise<Carteira> {
  await ensureSchema();
  const sql = db();
  const [linhas, retratos] = (await Promise.all([
    sql`
      select id, banco, nome, tipo, subtipo, situacao, saldo, aplicado, lucro,
             taxa, indexador, taxa_fixa, vencimento, emissor, atualizado
        from investimentos
       order by saldo desc, nome
    `,
    sql`
      select data, investido, em_conta from patrimonio
       order by data desc
       limit 180
    `,
  ])) as Array<Array<Record<string, unknown>>>;

  const ativos: Investimento[] = [];
  const encerrados: Investimento[] = [];
  let atualizado: string | null = null;
  for (const l of linhas) {
    const item: Investimento = {
      id: String(l.id),
      banco: String(l.banco),
      nome: String(l.nome),
      tipo: String(l.tipo),
      subtipo: l.subtipo == null ? null : String(l.subtipo),
      saldo: num(l.saldo),
      aplicado: opcional(l.aplicado),
      lucro: opcional(l.lucro),
      taxa: opcional(l.taxa),
      indexador: l.indexador == null ? null : String(l.indexador),
      taxaFixa: opcional(l.taxa_fixa),
      vencimento: iso(l.vencimento),
      emissor: l.emissor == null ? null : String(l.emissor),
    };
    const quando =
      l.atualizado instanceof Date ? l.atualizado.toISOString() : String(l.atualizado ?? "");
    if (quando && (!atualizado || quando > atualizado)) atualizado = quando;
    if (l.situacao === "TOTAL_WITHDRAWAL" || !(item.saldo > 0)) encerrados.push(item);
    else ativos.push(item);
  }

  const historico = retratos
    .map((r) => ({
      data: iso(r.data) ?? "",
      investido: num(r.investido),
      emConta: num(r.em_conta),
    }))
    .reverse();

  return {
    ativos,
    encerrados,
    total: Math.round(ativos.reduce((s, i) => s + i.saldo, 0) * 100) / 100,
    porTipo: somar(ativos, (i) => rotuloTipo(i.tipo)),
    porBanco: somar(ativos, (i) => i.banco),
    emConta: historico.length > 0 ? historico[historico.length - 1].emConta : 0,
    atualizado,
    historico,
  };
}
