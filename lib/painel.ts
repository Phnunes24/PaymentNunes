/**
 * O que as telas do painel precisam do banco: o mes escolhido, tudo que
 * aparece nele e o historico dos meses anteriores.
 */
import { db, ensureSchema } from "./db";
import {
  contasDoMes,
  faturasNoIntervalo,
  gastosDoMes,
  listarContas,
  rendaDoMes,
  type Conta,
  type Gasto,
  type LinhaMes,
} from "./data";
import { hoje, parseInteiro } from "./format";
import { resumir, type LinhaResumo, type Resumo } from "./resumo";

export type MesEscolhido = {
  ano: number;
  mes: number;
  /** O endereco trouxe ano e mes; sem isso vale o mes de hoje. */
  explicito: boolean;
  ehMesAtual: boolean;
  agora: ReturnType<typeof hoje>;
};

export function lerMes(sp: { ano?: string; mes?: string }): MesEscolhido {
  const agora = hoje();
  const ano = parseInteiro(sp.ano ?? null, agora.ano) ?? agora.ano;
  const mesBruto = parseInteiro(sp.mes ?? null, agora.mes) ?? agora.mes;
  const mes = mesBruto >= 1 && mesBruto <= 12 ? mesBruto : agora.mes;
  return {
    ano,
    mes,
    explicito: Boolean(sp.ano && sp.mes),
    ehMesAtual: ano === agora.ano && mes === agora.mes,
    agora,
  };
}

export type Painel = {
  linhas: LinhaMes[];
  gastos: Gasto[];
  contas: Conta[];
  /** Nomes dos cartoes cadastrados. */
  cartoes: string[];
  renda: number;
  resumo: Resumo;
  /** Mensagem de erro quando o banco nao respondeu. */
  falha: string | null;
};

/** Tudo de um mes. Se o banco falhar, devolve o mes vazio com o motivo, para
 *  a tela explicar em vez de quebrar. */
export async function carregarPainel(ano: number, mes: number): Promise<Painel> {
  let linhas: LinhaMes[] = [];
  let gastos: Gasto[] = [];
  let contas: Conta[] = [];
  let renda = 0;
  let falha: string | null = null;

  try {
    [linhas, gastos, contas, renda] = await Promise.all([
      contasDoMes(ano, mes),
      gastosDoMes(ano, mes),
      listarContas(),
      rendaDoMes(ano, mes),
    ]);
  } catch (e) {
    falha = e instanceof Error ? e.message : String(e);
  }

  const cartoes = contas.filter((c) => c.tipo === "cartao").map((c) => c.nome);
  return {
    linhas,
    gastos,
    contas,
    cartoes,
    renda,
    resumo: resumir(linhas, gastos, renda, cartoes),
    falha,
  };
}

export type MesHistorico = {
  ano: number;
  mes: number;
  renda: number;
  /** Contas mais gastos fora do cartao. */
  saidas: number;
  sobra: number;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Renda, saidas e sobra dos ultimos meses, do mais antigo para o mais novo,
 * terminando no mes pedido. So entram meses que ja foram abertos: este
 * historico nunca cria mes, so le. A conta e a mesma da tela do mes.
 */
export async function historico(
  ano: number,
  mes: number,
  quantos = 6
): Promise<MesHistorico[]> {
  await ensureSchema();
  const sql = db();
  const ate = ano * 12 + mes;
  const de = ate - quantos + 1;

  const [linhas, gastos, rendas, cartoes] = (await Promise.all([
    sql`
      select m.ano, m.mes, c.nome, c.tipo,
             m.previsto, m.previsto_manual, m.pago, m.valor_pago
        from contas_mes m
        join contas c on c.id = m.conta_id
       where m.ano * 12 + m.mes between ${de} and ${ate}
         and (c.ativo or m.pago)
    `,
    sql`
      select extract(year from data)::int as ano,
             extract(month from data)::int as mes,
             pago_com, sum(valor) as total
        from gastos
       where extract(year from data)::int * 12 + extract(month from data)::int
             between ${de} and ${ate}
       group by 1, 2, 3
    `,
    sql`select ano, mes, valor from renda order by ano, mes`,
    sql`select nome from contas where ativo and tipo = 'cartao'`,
  ])) as Array<Array<Record<string, unknown>>>;

  // A fatura de cada cartao segue o fechamento dele, igual a tela do mes.
  const faturas = await faturasNoIntervalo(de, ate);

  const gastosDe = new Map<number, Array<{ pago_com: string; valor: number }>>();
  for (const g of gastos) {
    const indice = num(g.ano) * 12 + num(g.mes);
    const lista = gastosDe.get(indice) ?? [];
    lista.push({ pago_com: String(g.pago_com), valor: num(g.total) });
    gastosDe.set(indice, lista);
  }

  const linhasDe = new Map<number, Array<Record<string, unknown>>>();
  for (const l of linhas) {
    const indice = num(l.ano) * 12 + num(l.mes);
    const lista = linhasDe.get(indice) ?? [];
    lista.push(l);
    linhasDe.set(indice, lista);
  }

  // Mes sem renda propria herda a ultima cadastrada antes dele; mes anterior
  // a todas vale a primeira. Igual a rendaDoMes.
  const rendaDe = (indice: number): number => {
    let valor: number | null = null;
    for (const r of rendas) {
      if (num(r.ano) * 12 + num(r.mes) <= indice) valor = num(r.valor);
    }
    return valor ?? (rendas.length > 0 ? num(rendas[0].valor) : 0);
  };

  const ativos = cartoes.map((c) => String(c.nome));
  const meses: MesHistorico[] = [];
  for (let indice = de; indice <= ate; indice++) {
    const doMes = linhasDe.get(indice);
    if (!doMes) continue;
    const gastosDoIndice = gastosDe.get(indice) ?? [];
    const fatura = faturas.get(indice) ?? new Map<string, number>();

    const paraResumo: LinhaResumo[] = doMes.map((l) => {
      const tipo = l.tipo === "cartao" ? "cartao" : "fixa";
      const nome = String(l.nome);
      const previsto =
        tipo === "cartao" && !l.previsto_manual
          ? (fatura.get(nome) ?? 0)
          : num(l.previsto);
      const pago = Boolean(l.pago);
      return {
        nome,
        tipo,
        pago,
        previsto,
        pagoEfetivo: pago
          ? l.valor_pago == null
            ? previsto
            : num(l.valor_pago)
          : 0,
        status: pago ? "pago" : "aberto",
      };
    });

    const r = resumir(paraResumo, gastosDoIndice, rendaDe(indice), ativos);
    meses.push({
      ano: Math.floor((indice - 1) / 12),
      mes: ((indice - 1) % 12) + 1,
      renda: r.renda,
      saidas: r.comprometido,
      sobra: r.sobra,
    });
  }
  return meses;
}
