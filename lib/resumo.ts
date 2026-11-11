/**
 * Contas do painel, sem banco nem tela: quanto sobra, o que vence quando,
 * gastos agrupados por dia. Tudo aqui e funcao pura, para dar para testar.
 */
import type { Gasto, LinhaMes } from "./data";

/** Como esta o mes: sobra folgada, sobra curta (menos de 10% da renda) ou
 *  mais saidas que renda. E o que pinta a aurora do fundo. */
export type Clima = "bom" | "aperto" | "estourou";

export type Resumo = {
  renda: number;
  /** Contas ja pagas no mes. */
  contasPagas: number;
  /** Contas do mes que ainda vao sair. */
  contasAPagar: number;
  /** Gastos pagos fora do cartao (Pix, debito, dinheiro, boleto). */
  gastosAvulsos: number;
  /** Tudo que sai no mes: contas pagas, contas a pagar e gastos avulsos. */
  comprometido: number;
  sobra: number;
  /** Todos os gastos lancados, no cartao ou fora dele. */
  totalGastos: number;
  pagas: number;
  total: number;
  atrasadas: number;
  clima: Clima;
};

/** O pedaco de uma conta do mes que entra na soma. */
export type LinhaResumo = Pick<
  LinhaMes,
  "nome" | "tipo" | "pago" | "previsto" | "pagoEfetivo" | "status"
>;

function centavos(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Quanto uma conta pesa no mes. Conta fixa ja paga vale o que foi pago de
 * verdade (com desconto ou multa). Cartao vale sempre as compras do mes,
 * pago ou nao: a fatura daqui e a soma das compras, e continuar comprando
 * depois de pagar nao pode sumir da conta.
 */
export function valorDaConta(l: LinhaResumo): number {
  return l.tipo === "fixa" && l.pago ? l.pagoEfetivo : l.previsto;
}

export function resumir(
  linhas: LinhaResumo[],
  gastos: Array<Pick<Gasto, "pago_com" | "valor">>,
  renda: number,
  cartoesAtivos: string[]
): Resumo {
  // Gasto no cartao ja esta dentro da fatura. So o que saiu por fora entra de
  // novo na conta, senao contaria duas vezes. Cartao ja apagado que aparece
  // no mes, porque foi pago, tambem vale como cartao.
  const cartoes = new Set([
    ...cartoesAtivos,
    ...linhas.filter((l) => l.tipo === "cartao").map((l) => l.nome),
  ]);

  let contasPagas = 0;
  let contasAPagar = 0;
  let pagas = 0;
  let atrasadas = 0;
  for (const l of linhas) {
    if (l.pago) {
      contasPagas += valorDaConta(l);
      pagas++;
    } else {
      contasAPagar += valorDaConta(l);
      if (l.status === "atrasado") atrasadas++;
    }
  }

  let totalGastos = 0;
  let gastosAvulsos = 0;
  for (const g of gastos) {
    totalGastos += g.valor;
    if (!cartoes.has(g.pago_com)) gastosAvulsos += g.valor;
  }

  const comprometido = centavos(contasPagas + contasAPagar + gastosAvulsos);
  const sobra = centavos(renda - comprometido);
  const clima: Clima =
    sobra < 0 ? "estourou" : renda > 0 && sobra < renda * 0.1 ? "aperto" : "bom";

  return {
    renda,
    contasPagas: centavos(contasPagas),
    contasAPagar: centavos(contasAPagar),
    gastosAvulsos: centavos(gastosAvulsos),
    comprometido,
    sobra,
    totalGastos: centavos(totalGastos),
    pagas,
    total: linhas.length,
    atrasadas,
    clima,
  };
}

// ------------------------------------------------------------- datas ---

function utc(iso: string): number {
  const [a, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(a, m - 1, d);
}

/** Dias de `de` ate `ate`. Negativo quando `ate` ja passou. */
export function diasEntre(de: string, ate: string): number {
  return Math.round((utc(ate) - utc(de)) / 864e5);
}

function diaMes(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** "vence amanhã", "venceu há 3 dias", "pago dia 08/11". */
export function quandoVence(l: LinhaMes, hojeIso: string): string {
  if (l.pago) return l.data_pgto ? `pago dia ${diaMes(l.data_pgto)}` : "pago";
  if (!l.vencimento) return "sem dia de vencimento";
  const dias = diasEntre(hojeIso, l.vencimento);
  if (dias === 0) return "vence hoje";
  if (dias === 1) return "vence amanhã";
  if (dias === -1) return "venceu ontem";
  if (dias > 1 && dias <= 7) return `vence em ${dias} dias`;
  if (dias < -1 && dias >= -30) return `venceu há ${-dias} dias`;
  return dias > 0
    ? `vence dia ${diaMes(l.vencimento)}`
    : `venceu dia ${diaMes(l.vencimento)}`;
}

/** Contas em aberto na ordem em que pedem atencao: primeiro a que vence (ou
 *  venceu) antes, por ultimo as sem dia de vencimento. */
export function aPagar(linhas: LinhaMes[]): LinhaMes[] {
  return linhas
    .filter((l) => !l.pago)
    .sort((a, b) => {
      if (a.vencimento && b.vencimento) {
        return a.vencimento < b.vencimento ? -1 : a.vencimento > b.vencimento ? 1 : 0;
      }
      if (a.vencimento) return -1;
      if (b.vencimento) return 1;
      return 0;
    });
}

const DIA_SEMANA = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** "Hoje", "Ontem" ou "segunda-feira, 9 de novembro". */
export function rotuloDia(iso: string, hojeIso: string): string {
  const dias = diasEntre(iso, hojeIso);
  if (dias === 0) return "Hoje";
  if (dias === 1) return "Ontem";
  const texto = DIA_SEMANA.format(new Date(utc(iso)));
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// ------------------------------------------------------------ gastos ---

export type DiaDeGastos = { data: string; total: number; itens: Gasto[] };

/** Gastos agrupados por dia, do mais recente para o mais antigo. */
export function porDia(gastos: Gasto[]): DiaDeGastos[] {
  const mapa = new Map<string, DiaDeGastos>();
  for (const g of gastos) {
    const dia = mapa.get(g.data);
    if (dia) {
      dia.itens.push(g);
      dia.total += g.valor;
    } else {
      mapa.set(g.data, { data: g.data, total: g.valor, itens: [g] });
    }
  }
  return [...mapa.values()]
    .map((d) => ({ ...d, total: centavos(d.total) }))
    .sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
}

/** Total gasto em cada dia do mes; a posicao 0 e o dia 1. */
export function totaisPorDia(gastos: Gasto[], diasNoMes: number): number[] {
  const totais = new Array<number>(diasNoMes).fill(0);
  for (const g of gastos) {
    const dia = Number(g.data.slice(8, 10));
    if (dia >= 1 && dia <= diasNoMes) totais[dia - 1] += g.valor;
  }
  return totais.map(centavos);
}

/** Soma por um campo do gasto, do maior para o menor. */
export function somarPor(
  gastos: Gasto[],
  campo: "categoria" | "pago_com"
): Array<[string, number]> {
  const mapa = new Map<string, number>();
  for (const g of gastos) mapa.set(g[campo], (mapa.get(g[campo]) ?? 0) + g.valor);
  return [...mapa.entries()]
    .map(([nome, valor]): [string, number] => [nome, centavos(valor)])
    .sort((a, b) => b[1] - a[1]);
}

export function diasNoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

// ----------------------------------------------------- fatura do cartao ---

/** Posicao de um mes na linha do tempo: ano * 12 + mes. */
export function indiceDoMes(ano: number, mes: number): number {
  return ano * 12 + mes;
}

export function mesDoIndice(indice: number): { ano: number; mes: number } {
  return { ano: Math.floor((indice - 1) / 12), mes: ((indice - 1) % 12) + 1 };
}

/**
 * Em que fatura cai uma compra no cartao, como o mes em que essa fatura
 * vence. Sem dia de fechamento cadastrado, vale o mes da propria compra.
 *
 * A fatura fecha no dia de fechamento (31 quer dizer ultimo dia do mes) e a
 * compra feita nesse dia ja e da fatura seguinte. O vencimento vem depois do
 * fechamento: no mesmo mes, se o dia de vencimento for maior, ou no seguinte.
 * Sem dia de vencimento, supoe uns 8 dias depois de fechar.
 */
export function faturaDaCompra(
  data: string,
  fechamento: number | null,
  vencimento: number | null
): number {
  const [ano, mes, dia] = data.slice(0, 10).split("-").map(Number);
  const daCompra = indiceDoMes(ano, mes);
  if (fechamento == null) return daCompra;

  const fechaNoMesDaCompra = Math.min(fechamento, diasNoMes(ano, mes));
  const fecha = dia < fechaNoMesDaCompra ? daCompra : daCompra + 1;
  const mesQueFecha = mesDoIndice(fecha);
  const ultimoDia = diasNoMes(mesQueFecha.ano, mesQueFecha.mes);
  const diaQueFecha = Math.min(fechamento, ultimoDia);

  if (vencimento != null) return vencimento > diaQueFecha ? fecha : fecha + 1;
  return diaQueFecha + 8 > ultimoDia ? fecha + 1 : fecha;
}
