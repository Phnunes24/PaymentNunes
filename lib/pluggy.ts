/**
 * Leitura das contas e transacoes dos bancos pela API da Pluggy (Open Finance),
 * pelo caminho de uso pessoal: Meu Pluggy + conector MeuPluggy, que e gratis.
 * Aqui ficam a conversa com a API e as regras puras que decidem o que vira
 * gasto. Gravar no banco e com lib/bancos.ts.
 *
 * Doc: https://docs.pluggy.ai/en/docs/guides/meu-pluggy-personal-use
 */
import { casarCartao, categorizar, normaliza } from "./regras";

const API = "https://api.pluggy.ai";
const FUSO = "America/Sao_Paulo";

export type PluggyItem = {
  id: string;
  status: string;
  connector?: { name?: string } | null;
  consentExpiresAt?: string | null;
  lastUpdatedAt?: string | null;
  error?: { code?: string; message?: string } | null;
};

export type PluggyConta = {
  id: string;
  type: "BANK" | "CREDIT";
  subtype?: string | null;
  name?: string | null;
  marketingName?: string | null;
  number?: string | null;
};

export type PluggyTransacao = {
  id: string;
  date: string;
  description?: string | null;
  amount: number;
  amountInAccountCurrency?: number | null;
  currencyCode?: string | null;
  type: "DEBIT" | "CREDIT";
  status?: string | null;
  operationType?: string | null;
  providerId?: string | null;
  category?: string | null;
};

async function chamar<T>(caminho: string, apiKey: string | null, init?: RequestInit): Promise<T> {
  const r = await fetch(API + caminho, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-API-KEY": apiKey } : {}),
    },
    cache: "no-store",
  });
  if (!r.ok) {
    const corpo = (await r.text()).slice(0, 200);
    throw new Error(`Pluggy respondeu ${r.status} em ${caminho.split("?")[0]}: ${corpo}`);
  }
  return (await r.json()) as T;
}

/** Troca client id e secret por uma chave de API (vale 2 horas). */
export async function autenticar(clientId: string, clientSecret: string): Promise<string> {
  const r = await chamar<{ apiKey: string }>("/auth", null, {
    method: "POST",
    body: JSON.stringify({ clientId, clientSecret }),
  });
  return r.apiKey;
}

export function buscarItem(apiKey: string, itemId: string): Promise<PluggyItem> {
  return chamar<PluggyItem>(`/items/${encodeURIComponent(itemId)}`, apiKey);
}

export async function buscarContas(apiKey: string, itemId: string): Promise<PluggyConta[]> {
  const r = await chamar<{ results: PluggyConta[] }>(
    `/accounts?itemId=${encodeURIComponent(itemId)}`,
    apiKey
  );
  return r.results ?? [];
}

/** Transacoes de uma conta a partir de uma data (aaaa-mm-dd), todas as paginas. */
export async function buscarTransacoes(
  apiKey: string,
  contaId: string,
  desde: string
): Promise<PluggyTransacao[]> {
  const todas: PluggyTransacao[] = [];
  let proxima: string | null =
    `?accountId=${encodeURIComponent(contaId)}&dateFrom=${desde}`;
  // 500 por pagina; 20 paginas ja e muito mais que um mes de uso.
  for (let i = 0; proxima && i < 20; i++) {
    const r: { results: PluggyTransacao[]; next: string | null } = await chamar(
      `/v2/transactions${proxima}`,
      apiKey
    );
    todas.push(...(r.results ?? []));
    proxima = r.next;
  }
  return todas;
}

// --------------------------------------------------------------- regras ---

/** Data da transacao no fuso do Brasil. Data "pura" (meia-noite UTC) vale
 *  como esta; horario de verdade e convertido, senao a compra das 22h cairia
 *  no dia seguinte. */
export function dataBrasil(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso) || /T00:00:00(\.0+)?Z$/.test(iso)) {
    return iso.slice(0, 10);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const MINUSCULAS = new Set(["de", "da", "do", "das", "dos", "e", "em"]);

/** "PADARIA REAL  LTDA" -> "Padaria Real Ltda". Texto que ja tem minuscula
 *  fica como veio. */
export function limparDescricao(bruta: string | null | undefined): string {
  const s = (bruta ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (s === "") return "Compra";
  if (/[a-zà-ú]/.test(s)) return s;
  return s
    .toLowerCase()
    .split(" ")
    .map((p, i) =>
      i > 0 && MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)
    )
    .join(" ");
}

const MARCAS: Array<[RegExp, string]> = [
  [/\bnu pagamentos\b|nubank/, "Nubank"],
  [/\bc6\b/, "C6 Bank"],
  [/bradesco/, "Bradesco"],
  [/\bitau\b/, "Itaú"],
  [/santander/, "Santander"],
  [/banco do brasil/, "Banco do Brasil"],
  [/caixa economica/, "Caixa"],
  [/\binter\b/, "Inter"],
  [/mercado pago/, "Mercado Pago"],
  [/picpay/, "PicPay"],
  [/pagbank|pagseguro/, "PagBank"],
  [/\bbtg\b/, "BTG"],
  [/\bxp\b/, "XP"],
  [/sicoob/, "Sicoob"],
  [/sicredi/, "Sicredi"],
];

/**
 * Nome do banco de uma conexao. Pelo Meu Pluggy o conector se chama sempre
 * "MeuPluggy", entao o banco de verdade sai dos nomes das contas: a conta do
 * Nubank vem como "Nu Pagamentos S.A.", a do C6 como "C6 BANK".
 */
export function bancoDe(contas: PluggyConta[], conector?: string | null): string {
  const texto = normaliza(
    [conector ?? "", ...contas.flatMap((c) => [c.name ?? "", c.marketingName ?? ""])].join(" ")
  );
  for (const [padrao, marca] of MARCAS) {
    if (padrao.test(texto)) return marca;
  }
  const corrente = contas.find((c) => c.type === "BANK");
  return (corrente?.name || conector || "Banco").split(" - ")[0].trim().slice(0, 30);
}

const SUBTIPOS: Record<string, string> = {
  CHECKING_ACCOUNT: "Conta corrente",
  SAVINGS_ACCOUNT: "Poupança",
};

function finalDe(c: PluggyConta): string {
  return (c.number ?? "").replace(/\D/g, "").slice(-4);
}

/** Nome curto da conta para mostrar na tela: "gold final 4947", "Conta
 *  corrente final 9373". */
export function nomeDaConta(c: PluggyConta): string {
  const base =
    c.type === "CREDIT"
      ? (c.name || c.marketingName || "Cartão").trim()
      : (SUBTIPOS[c.subtype ?? ""] ?? (c.name || "Conta").trim());
  const final = finalDe(c);
  return final ? `${base} final ${final}` : base;
}

/** Com que nome entra a compra de um cartao que nao casou com nenhum cartao
 *  cadastrado: "C6 Bank final 0722". */
export function rotuloDoCartao(c: PluggyConta, banco?: string | null): string {
  if (!banco) return nomeDaConta(c);
  const final = finalDe(c);
  return final ? `${banco} final ${final}` : banco;
}

/** Texto usado para casar o cartao do banco com um cartao cadastrado. Leva o
 *  nome do banco, porque o cartao em si costuma se chamar so "gold". */
export function textoDoCartao(c: PluggyConta, banco?: string | null): string {
  return `${c.name ?? ""} ${c.marketingName ?? ""} ${banco ?? ""}`.trim();
}

/** Identificador estavel da transacao. O providerId vem do banco e
 *  sobrevive quando a Pluggy recria a transacao com outro id. */
export function chaveDe(tx: PluggyTransacao): string {
  return tx.providerId ? `of:${tx.providerId}` : `pluggy:${tx.id}`;
}

const PAGAMENTO_FATURA =
  /(pagamento|pagto|pgto|pag)\.? (de |da |do )?(fatura|cartao)|fatura (do |de )?(cartao|nubank|bradesco|credito)|pagamento recebido/;

/** Saidas que podem ser so dinheiro indo para outra conta sua. */
export const OPERACOES_TRANSFERENCIA = new Set([
  "PIX",
  "TED",
  "DOC",
  "TRANSFERENCIA_MESMA_INSTITUICAO",
]);
const INVESTIMENTO =
  /aplicacao|caixinha|dinheiro guardado|guardad[oa]|investimento|\bcdb\b|\brdb\b|\blci\b|\blca\b|poupanca|tesouro|resgate/;

const OPERACOES_CARTAO_IGNORADAS = new Set([
  "PAGAMENTO_FATURA",
  "ESTORNO",
  "CASHBACK",
  "OPERACOES_CREDITO_CONTRATADAS_CARTAO",
]);
const OPERACOES_CONTA_IGNORADAS = new Set([
  "RENDIMENTO_APLIC_FINANCEIRA",
  "RESGATE_APLIC_FINANCEIRA",
  "PORTABILIDADE_SALARIO",
]);

/** Forma de pagamento de uma saida da conta corrente. */
function formaDaConta(op: string | null | undefined): string {
  switch (op) {
    case "PIX":
      return "Pix";
    case "TED":
    case "DOC":
    case "TRANSFERENCIA_MESMA_INSTITUICAO":
      return "Transferência";
    case "BOLETO":
    case "CONVENIO_ARRECADACAO":
      return "Boleto";
    case "SAQUE":
      return "Dinheiro";
    default:
      return "Débito";
  }
}

// Categoria da Pluggy (so vem em plano pago) para a nossa, quando o nome da
// loja nao disse nada.
const CATEGORIAS_PLUGGY: Array<[RegExp, string]> = [
  [/groceries|supermarket/i, "Mercado"],
  [/eating out|restaurant|food|delivery/i, "Alimentação"],
  [/gas station|fuel/i, "Combustível"],
  [/taxi|ride|transport|parking|toll|public transport/i, "Transporte"],
  [/pharmacy|health|hospital|dentist/i, "Saúde"],
  [/streaming|digital service|subscription/i, "Assinaturas"],
  [/leisure|entertainment|culture|tickets/i, "Lazer"],
  [/housing|rent|utilities|electricity|water|internet|home/i, "Casa"],
];

function categoriaDe(descricao: string, categoriaPluggy?: string | null): string {
  const nossa = categorizar(descricao);
  if (nossa !== "Outros" || !categoriaPluggy) return nossa;
  for (const [padrao, cat] of CATEGORIAS_PLUGGY) {
    if (padrao.test(categoriaPluggy)) return cat;
  }
  return "Outros";
}

export type Decisao =
  | { acao: "ignorar"; motivo: string }
  | {
      acao: "gasto";
      data: string;
      descricao: string;
      valor: number;
      pagoCom: string;
      categoria: string;
      /** Compra no cartao de credito (true) ou saida da conta corrente. */
      cartao: boolean;
    };

/**
 * O que fazer com uma transacao. Entram as compras do cartao e as saidas da
 * conta corrente; ficam de fora entradas, pagamento de fatura (os gastos ja
 * vieram do cartao), investimento e saida agendada que ainda nao aconteceu.
 *
 * `cartaoEscolhido` e o nome da conta de cartao que voce ligou a este cartao
 * do banco; sem escolha, tenta casar pelo nome do cartao e do banco.
 */
export function decidir(
  tx: PluggyTransacao,
  conta: PluggyConta,
  nomesCartoes: string[],
  hojeIso: string,
  cartaoEscolhido?: string | null,
  banco?: string | null
): Decisao {
  const data = dataBrasil(tx.date);
  const descricao = limparDescricao(tx.description);
  const texto = normaliza(tx.description ?? "");
  const op = tx.operationType ?? null;
  const bruto =
    tx.currencyCode && tx.currencyCode !== "BRL" && tx.amountInAccountCurrency != null
      ? tx.amountInAccountCurrency
      : tx.amount;
  const valor = Math.round(Math.abs(bruto) * 100) / 100;

  if (!(valor > 0)) return { acao: "ignorar", motivo: "valor zero" };

  if (conta.type === "CREDIT") {
    if (conta.subtype && conta.subtype !== "CREDIT_CARD") {
      return { acao: "ignorar", motivo: "empréstimo ou financiamento" };
    }
    // No cartao, positivo e compra; negativo e pagamento ou estorno.
    if (!(bruto > 0)) return { acao: "ignorar", motivo: "pagamento ou estorno" };
    if (op && OPERACOES_CARTAO_IGNORADAS.has(op)) {
      return { acao: "ignorar", motivo: "pagamento, estorno ou cashback" };
    }
    if (PAGAMENTO_FATURA.test(texto)) {
      return { acao: "ignorar", motivo: "pagamento de fatura" };
    }
    const pagoCom =
      cartaoEscolhido ||
      casarCartao(textoDoCartao(conta, banco), nomesCartoes) ||
      rotuloDoCartao(conta, banco);
    return {
      acao: "gasto",
      data,
      descricao,
      valor,
      pagoCom,
      categoria: categoriaDe(descricao, tx.category),
      cartao: true,
    };
  }

  // Conta corrente ou poupanca: so saidas.
  if (tx.type !== "DEBIT") return { acao: "ignorar", motivo: "entrada" };
  if (tx.status === "PENDING" && data > hojeIso) {
    return { acao: "ignorar", motivo: "agendado" };
  }
  if (op && OPERACOES_CONTA_IGNORADAS.has(op)) {
    return { acao: "ignorar", motivo: "investimento" };
  }
  if (PAGAMENTO_FATURA.test(texto)) {
    return { acao: "ignorar", motivo: "pagamento de fatura" };
  }
  if (INVESTIMENTO.test(texto)) return { acao: "ignorar", motivo: "investimento" };

  return {
    acao: "gasto",
    data,
    descricao,
    valor,
    pagoCom: formaDaConta(op),
    categoria: op === "SAQUE" ? "Outros" : categoriaDe(descricao, tx.category),
    cartao: false,
  };
}

function dias(a: string, b: string): number {
  return Math.abs(Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5;
}

export type Lida = {
  chave: string;
  tx: PluggyTransacao;
  conta: PluggyConta;
  /** Nome do banco da conexao de onde a transacao veio. */
  banco?: string;
};

/**
 * Saidas da conta corrente que sao dinheiro mudando de lugar entre as suas
 * proprias contas: transferencia para outra conta sua (aparece uma entrada
 * de mesmo valor em outra conta) ou pagamento da fatura de um cartao seu
 * (aparece o pagamento no cartao). Nenhuma das duas e gasto.
 */
export function movimentosInternos(lidas: Lida[]): Set<string> {
  const internos = new Set<string>();
  const usados = new Set<string>();
  const saidas = lidas.filter((l) => l.conta.type === "BANK" && l.tx.type === "DEBIT");
  for (const s of saidas) {
    const valor = Math.abs(s.tx.amount);
    const data = dataBrasil(s.tx.date);
    const par = lidas.find((o) => {
      if (o.conta.id === s.conta.id || usados.has(o.chave)) return false;
      if (Math.abs(Math.abs(o.tx.amount) - valor) > 0.005) return false;
      const entradaEmConta = o.conta.type === "BANK" && o.tx.type === "CREDIT";
      const pagamentoNoCartao = o.conta.type === "CREDIT" && o.tx.amount < 0;
      if (!entradaEmConta && !pagamentoNoCartao) return false;
      return dias(dataBrasil(o.tx.date), data) <= (pagamentoNoCartao ? 3 : 1);
    });
    if (par) {
      internos.add(s.chave);
      usados.add(par.chave);
    }
  }
  return internos;
}

export type ContaAberta = { id: number; ano: number; mes: number; previsto: number; nome: string };

/** Conta fixa do mes ainda nao paga cujo valor bate com a saida (diferenca de
 *  ate 2% ou R$ 1). E o boleto do carro, da faculdade: em vez de virar gasto,
 *  a conta e marcada como paga. */
export function casarContaAberta(
  valor: number,
  data: string,
  abertas: ContaAberta[]
): ContaAberta | null {
  const [ano, mes] = data.split("-").map(Number);
  let melhor: ContaAberta | null = null;
  for (const c of abertas) {
    if (c.ano !== ano || c.mes !== mes || !(c.previsto > 0)) continue;
    const dif = Math.abs(c.previsto - valor);
    if (dif > Math.max(1, c.previsto * 0.02)) continue;
    if (!melhor || dif < Math.abs(melhor.previsto - valor)) melhor = c;
  }
  return melhor;
}

export type GastoSolto = { id: number; data: string; valor: number; pago_com: string };

/** Gasto ja lancado (a mao ou pelo Apple Pay) que e esta mesma compra: mesmo
 *  cartao, mesmo valor, ate 2 dias de diferenca. */
export function acharMesmoGasto(
  d: { data: string; valor: number; pagoCom: string },
  soltos: GastoSolto[]
): GastoSolto | null {
  return (
    soltos.find(
      (g) =>
        g.pago_com === d.pagoCom &&
        Math.abs(g.valor - d.valor) < 0.005 &&
        dias(g.data, d.data) <= 2
    ) ?? null
  );
}
