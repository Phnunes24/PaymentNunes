import type { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { db, ensureSchema } from "@/lib/db";
import { listarContas } from "@/lib/data";
import { hoje, moeda, parseValor } from "@/lib/format";
import { casarCartao, categorizar } from "@/lib/applepay";

export const dynamic = "force-dynamic";

/**
 * Recebe uma compra feita com Apple Pay, enviada pela automacao "Transacao"
 * do app Atalhos do iPhone, e lanca como gasto.
 *
 * POST /api/apple-pay
 * Authorization: Bearer <ATALHO_TOKEN>
 * { "valor": "R$ 32,50", "estabelecimento": "Padaria Real", "cartao": "Nubank" }
 *
 * O cartao da Wallet e casado com a conta de cartao cadastrada, entao a
 * compra ja entra na fatura certa. A categoria e escolhida pelo nome do
 * estabelecimento.
 */

function autorizado(req: NextRequest): boolean {
  const esperado = process.env.ATALHO_TOKEN || "";
  // Sem token configurado, ou fraco demais, nada entra.
  if (esperado.length < 16) return false;
  const cabecalho = req.headers.get("authorization") || "";
  const recebido = cabecalho.startsWith("Bearer ")
    ? cabecalho.slice(7).trim()
    : "";
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function lerCorpo(req: NextRequest): Promise<Record<string, string>> {
  const corpo: Record<string, string> = {};
  const tipo = req.headers.get("content-type") || "";
  if (tipo.includes("application/json")) {
    const json = (await req.json()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(json ?? {})) {
      if (v != null) corpo[k.toLowerCase()] = String(v);
    }
  } else {
    const fd = await req.formData();
    fd.forEach((v, k) => {
      corpo[k.toLowerCase()] = String(v);
    });
  }
  return corpo;
}

function primeiro(corpo: Record<string, string>, ...chaves: string[]): string {
  for (const k of chaves) {
    const v = corpo[k];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return "";
}

export async function POST(req: NextRequest) {
  if (!autorizado(req)) {
    return Response.json({ ok: false, erro: "não autorizado" }, { status: 401 });
  }

  let corpo: Record<string, string>;
  try {
    corpo = await lerCorpo(req);
  } catch {
    return Response.json({ ok: false, erro: "corpo inválido" }, { status: 400 });
  }

  const valor = parseValor(primeiro(corpo, "valor", "quantia", "amount"));
  if (!(valor > 0)) {
    return Response.json(
      { ok: false, erro: "valor ausente ou inválido" },
      { status: 400 }
    );
  }

  const estabelecimento =
    primeiro(corpo, "estabelecimento", "comerciante", "merchant", "descricao") ||
    "Compra Apple Pay";
  const cartaoWallet = primeiro(corpo, "cartao", "cartão", "card", "nome");
  const dataBruta = primeiro(corpo, "data", "date");
  const data = /^\d{4}-\d{2}-\d{2}$/.test(dataBruta) ? dataBruta : hoje().iso;

  try {
    await ensureSchema();
    const contas = await listarContas();
    const nomesCartoes = contas.filter((c) => c.tipo === "cartao").map((c) => c.nome);
    const pagoCom =
      casarCartao(cartaoWallet, nomesCartoes) ?? (cartaoWallet || "Apple Pay");
    const categoria = categorizar(estabelecimento);
    const sql = db();

    // Se o atalho disparar duas vezes para o mesmo toque, nao duplica.
    const repetido = (await sql`
      select id from gastos
       where descricao = ${estabelecimento}
         and valor = ${valor}
         and pago_com = ${pagoCom}
         and data = ${data}
         and criado_em > now() - interval '3 minutes'
       limit 1
    `) as Array<{ id: number }>;

    if (repetido.length > 0) {
      return Response.json({
        ok: true,
        repetido: true,
        mensagem: `Já lançado: ${estabelecimento}, ${moeda(valor)}`,
      });
    }

    const [novo] = (await sql`
      insert into gastos (data, descricao, categoria, pago_com, valor)
      values (${data}, ${estabelecimento}, ${categoria}, ${pagoCom}, ${valor})
      returning id
    `) as Array<{ id: number }>;

    return Response.json({
      ok: true,
      gasto: {
        id: novo.id,
        data,
        descricao: estabelecimento,
        categoria,
        pago_com: pagoCom,
        valor,
      },
      mensagem: `Lançado: ${estabelecimento}, ${moeda(valor)} no ${pagoCom} (${categoria})`,
    });
  } catch (e) {
    return Response.json(
      { ok: false, erro: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
