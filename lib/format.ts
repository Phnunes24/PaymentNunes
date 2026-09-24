export const FUSO = "America/Sao_Paulo";

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** Data de hoje no fuso de Sao Paulo, e nao em UTC como o servidor do Vercel. */
export function hoje(): { ano: number; mes: number; dia: number; iso: string } {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [ano, mes, dia] = iso.split("-").map(Number);
  return { ano, mes, dia, iso };
}

export function nomeMes(mes: number): string {
  return MESES[mes - 1] ?? "";
}

export function rotuloMes(ano: number, mes: number): string {
  const nome = nomeMes(mes);
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} de ${ano}`;
}

export function moeda(valor: number): string {
  return valor.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/** Aceita "1326,74", "1.326,74" e "1326.74". */
export function parseValor(bruto: FormDataEntryValue | null): number {
  if (bruto == null) return 0;
  let texto = String(bruto).trim().replace(/\s/g, "").replace(/R\$/gi, "");
  if (texto === "") return 0;
  if (texto.includes(",")) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(texto);
  return Number.isFinite(n) ? n : 0;
}

export function parseInteiro(
  bruto: FormDataEntryValue | null,
  padrao: number | null = null
): number | null {
  if (bruto == null || String(bruto).trim() === "") return padrao;
  const n = Number.parseInt(String(bruto), 10);
  return Number.isFinite(n) ? n : padrao;
}

/** Move o mes para frente ou para tras sem estourar dezembro/janeiro. */
export function deslocaMes(
  ano: number,
  mes: number,
  passo: number
): { ano: number; mes: number } {
  const total = ano * 12 + (mes - 1) + passo;
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 };
}

export function dataBR(iso: string | null): string {
  if (!iso) return "";
  const [ano, mes, dia] = iso.slice(0, 10).split("-");
  return `${dia}/${mes}/${ano}`;
}
