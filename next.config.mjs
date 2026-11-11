import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));

/**
 * Em producao nada muda do padrao do Next.
 *
 * So no `npm run dev`, e so com BANCO_LOCAL=1 no .env.local, o driver do Neon
 * e trocado por um Postgres embutido (PGlite) que guarda os dados na pasta
 * .pglite. Assim o painel roda inteiro na maquina, sem banco na nuvem.
 */
export default function config(fase) {
  if (fase === PHASE_DEVELOPMENT_SERVER && process.env.BANCO_LOCAL === "1") {
    return {
      serverExternalPackages: ["@electric-sql/pglite"],
      webpack(cfg) {
        cfg.resolve.alias["@neondatabase/serverless"] = path.join(
          aqui,
          "dev/neon-local.mjs"
        );
        return cfg;
      },
    };
  }
  return {};
}
