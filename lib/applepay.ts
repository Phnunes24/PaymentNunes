/**
 * Regras para transformar uma compra feita com Apple Pay (enviada pelo
 * atalho "Transacao" do iPhone) em gasto: descobrir qual cartao cadastrado
 * foi usado e chutar a categoria pelo nome do estabelecimento.
 *
 * Sem imports de proposito, para poder ser testado direto com o node.
 */

/** Minusculas e sem acento: "Pão de Açúcar" -> "pao de acucar". */
export function normaliza(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// Palavras que nao ajudam a identificar o cartao.
const GENERICAS = new Set([
  "cartao",
  "card",
  "credito",
  "debito",
  "empresa",
  "visa",
  "mastercard",
  "master",
  "elo",
  "amex",
  "black",
  "platinum",
  "gold",
]);

/**
 * Devolve o nome da conta de cartao cadastrada que corresponde ao cartao da
 * Wallet, ou null. "Nubank Mastercard" casa com "Cartao Nubank", "Bradesco
 * Visa" casa com "Cartao Bradesco Empresa".
 */
export function casarCartao(
  cartaoWallet: string,
  nomesCartoes: string[]
): string | null {
  const alvo = normaliza(cartaoWallet);
  if (!alvo) return null;

  let melhor: { nome: string; pontos: number } | null = null;
  for (const nome of nomesCartoes) {
    const tokens = normaliza(nome)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !GENERICAS.has(t));
    const pontos = tokens.filter((t) => alvo.includes(t)).length;
    if (pontos > 0 && (!melhor || pontos > melhor.pontos)) {
      melhor = { nome, pontos };
    }
  }
  return melhor ? melhor.nome : null;
}

// Ordem importa: a primeira regra que casar define a categoria. Os nomes
// precisam ser identicos aos de CATEGORIAS em lib/data.ts.
const REGRAS: Array<[string, RegExp]> = [
  ["Combustível", /\b(posto|shell|ipiranga|petrobras|br mania|combustiv)/],
  [
    "Saúde",
    /\b(farmac|drogaria|droga ?raia|drogasil|pacheco|panvel|clinica|hospital|laborat|odonto|dentist)/,
  ],
  [
    "Mercado",
    /\b(supermerc|mercado|mercadinho|atacad|assai|carrefour|hortifruti|sacolao|pao de acucar|zaffari|angeloni|condor|savegnago)/,
  ],
  [
    "Alimentação",
    /\b(restaurante|lanch|burger|hamburg|pizza|ifood|padaria|panific|cafe|cafeteria|bar|acai|mcdonald|mc donald|subway|sushi|churrasc|sorvet|doceria|confeitaria|cervej)/,
  ],
  [
    "Transporte",
    /\b(uber|99 ?pop|99app|cabify|estacionament|pedagio|sem parar|veloe|metro|onibus|bilhete unico)/,
  ],
  [
    "Assinaturas",
    /\b(netflix|spotify|disney|prime video|amazon prime|apple\.com|youtube|deezer|hbo)/,
  ],
  ["Lazer", /\b(cinema|cinemark|ingresso|teatro|parque|boliche)/],
  [
    "Casa",
    /\b(leroy|telhanorte|material de constru|casas bahia|magazine luiza|tok ?stok|etna|madeira ?madeira)/,
  ],
];

/** Categoria a partir do nome do estabelecimento; "Outros" se nada casar. */
export function categorizar(estabelecimento: string): string {
  const s = normaliza(estabelecimento);
  for (const [categoria, padrao] of REGRAS) {
    if (padrao.test(s)) return categoria;
  }
  return "Outros";
}
