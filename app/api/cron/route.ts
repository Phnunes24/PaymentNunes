import type { NextRequest } from "next/server";
import { abrirMes } from "@/lib/data";
import { lerConfigBancos, sincronizarBancos } from "@/lib/bancos";
import { hoje, deslocaMes } from "@/lib/format";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Chamado pelo Vercel todo dia de manha. Deixa o mes corrente e o seguinte
 *  ja montados, para a pagina abrir pronta, e puxa as novidades dos bancos
 *  quando eles estao conectados. */
export async function GET(req: NextRequest) {
  const segredo = process.env.CRON_SECRET;
  if (segredo && req.headers.get("authorization") !== `Bearer ${segredo}`) {
    return new Response("não autorizado", { status: 401 });
  }

  const { ano, mes } = hoje();
  const seguinte = deslocaMes(ano, mes, 1);

  await abrirMes(ano, mes);
  await abrirMes(seguinte.ano, seguinte.mes);

  const bancos = (await lerConfigBancos()).configurado
    ? await sincronizarBancos()
    : null;

  return Response.json({
    ok: true,
    abertos: [`${mes}/${ano}`, `${seguinte.mes}/${seguinte.ano}`],
    bancos: bancos
      ? {
          novos: bancos.novos,
          guardados: bancos.guardados,
          vinculados: bancos.vinculados,
          ignorados: bancos.ignorados,
          erro: bancos.erro,
        }
      : "não conectados",
  });
}
