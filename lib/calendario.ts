/**
 * Vencimentos das contas como calendario (.ics), para o app Calendario do
 * iPhone assinar e avisar um dia antes. O endereco leva um token que so
 * aparece na tela para quem esta logado.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "./db";
import { contasDoMes, listarContas } from "./data";
import { deslocaMes, hoje, moeda } from "./format";
import { diasNoMes } from "./resumo";

/** Token do endereco do calendario. Sai do segredo do servidor, entao nao
 *  precisa de variavel nova, e nao revela a senha. */
export function tokenCalendario(): string | null {
  const segredo = process.env.AUTH_SECRET || process.env.APP_PASSWORD || "";
  if (!segredo) return null;
  return createHmac("sha256", segredo)
    .update("calendario-v1")
    .digest("hex")
    .slice(0, 40);
}

export function tokenConfere(recebido: string): boolean {
  const esperado = tokenCalendario();
  if (!esperado) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Lembrete = {
  uid: string;
  /** Dia do vencimento, aaaa-mm-dd. */
  data: string;
  nome: string;
  /** Valor previsto; null quando ainda nao da para saber (fatura futura). */
  valor: number | null;
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Contas em aberto com dia de vencimento, deste mes e dos dois seguintes. */
export async function lembretes(): Promise<Lembrete[]> {
  const { ano, mes } = hoje();
  const lista: Lembrete[] = [];

  // Este mes: o que esta na tela, com o valor de verdade.
  for (const l of await contasDoMes(ano, mes)) {
    if (l.pago || !l.vencimento) continue;
    lista.push({
      uid: `conta-${l.conta_id}-${ano}-${mes}`,
      data: l.vencimento,
      nome: l.nome,
      valor: l.previsto > 0 ? l.previsto : null,
    });
  }

  // Proximos dois meses: pelo cadastro, sem abrir o mes. Fica de fora o que
  // ja foi pago adiantado e a conta parcelada que ja tera acabado.
  const contas = await listarContas();
  const base = ano * 12 + mes;
  const pagasAdiantado = new Set(
    (
      (await db()`
        select conta_id, ano, mes from contas_mes
         where pago and ano * 12 + mes between ${base + 1} and ${base + 2}
      `) as Array<Record<string, unknown>>
    ).map((r) => `${r.conta_id}-${r.ano}-${r.mes}`)
  );

  for (let passo = 1; passo <= 2; passo++) {
    const alvo = deslocaMes(ano, mes, passo);
    const indice = alvo.ano * 12 + alvo.mes;
    for (const c of contas) {
      if (c.dia_vencimento == null) continue;
      if (pagasAdiantado.has(`${c.id}-${alvo.ano}-${alvo.mes}`)) continue;
      if (c.parcelas != null && c.parcela_inicio != null) {
        const numero = indice - c.parcela_inicio + 1;
        if (numero < 1 || numero > c.parcelas) continue;
      }
      const dia = Math.min(c.dia_vencimento, diasNoMes(alvo.ano, alvo.mes));
      lista.push({
        uid: `conta-${c.id}-${alvo.ano}-${alvo.mes}`,
        data: `${alvo.ano}-${pad(alvo.mes)}-${pad(dia)}`,
        nome: c.nome,
        valor: c.tipo === "fixa" && c.valor > 0 ? c.valor : null,
      });
    }
  }
  return lista;
}

function escapar(texto: string): string {
  return texto
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Linha de no maximo 75 bytes, como o formato pede; o resto continua na
 *  linha de baixo, que comeca com um espaco. */
function dobrar(linha: string): string {
  const pedacos: string[] = [];
  let resto = linha;
  while (Buffer.byteLength(resto) > 74) {
    pedacos.push(resto.slice(0, 60));
    resto = " " + resto.slice(60);
  }
  pedacos.push(resto);
  return pedacos.join("\r\n");
}

function dataIcs(iso: string, somaDias = 0): string {
  const [a, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d + somaDias));
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}

/** Monta o arquivo .ics: um evento de dia inteiro por vencimento, com aviso
 *  as 9h da vespera e as 9h do dia. */
export function montarIcs(itens: Lembrete[], agora: Date): string {
  const carimbo = agora.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const linhas = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Minhas contas//Vencimentos//PT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Contas a pagar",
    "X-WR-TIMEZONE:America/Sao_Paulo",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  for (const l of itens) {
    const titulo =
      l.valor != null ? `Vence ${l.nome}: ${moeda(l.valor)}` : `Vence ${l.nome}`;
    linhas.push(
      "BEGIN:VEVENT",
      `UID:${l.uid}@minhas-contas`,
      `DTSTAMP:${carimbo}`,
      `DTSTART;VALUE=DATE:${dataIcs(l.data)}`,
      `DTEND;VALUE=DATE:${dataIcs(l.data, 1)}`,
      `SUMMARY:${escapar(titulo)}`,
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapar(`${l.nome} vence amanhã`)}`,
      "TRIGGER:-PT15H",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapar(`${l.nome} vence hoje`)}`,
      "TRIGGER:PT9H",
      "END:VALARM",
      "END:VEVENT"
    );
  }
  linhas.push("END:VCALENDAR");
  return linhas.map(dobrar).join("\r\n") + "\r\n";
}
