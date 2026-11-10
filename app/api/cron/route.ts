import type { NextRequest } from "next/server";
import { abrirMes } from "@/lib/data";
import { hoje, deslocaMes } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Chamado pelo Vercel no dia 1 de cada mes. Deixa o mes corrente e o
 *  seguinte ja montados, para a pagina abrir pronta. */
export async function GET(req: NextRequest) {
  const segredo = process.env.CRON_SECRET;
  if (segredo && req.headers.get("authorization") !== `Bearer ${segredo}`) {
    return new Response("não autorizado", { status: 401 });
  }

  const { ano, mes } = hoje();
  const seguinte = deslocaMes(ano, mes, 1);

  await abrirMes(ano, mes);
  await abrirMes(seguinte.ano, seguinte.mes);

  return Response.json({
    ok: true,
    abertos: [`${mes}/${ano}`, `${seguinte.mes}/${seguinte.ano}`],
  });
}
