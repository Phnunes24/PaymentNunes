// Substituto local do driver do Neon. So entra no `npm run dev` com
// BANCO_LOCAL=1 (ver next.config.mjs); o deploy nunca usa este arquivo.
//
// Mesma interface que o app usa do Neon: neon(url) devolve uma funcao de
// template (sql`select ... ${valor}`) que responde com as linhas.
import { PGlite } from "@electric-sql/pglite";

// Uma instancia so, mesmo quando o Next recompila os modulos.
const pg = (globalThis.__bancoLocal ??= new PGlite("./.pglite"));

export function neon() {
  return async function sql(partes, ...valores) {
    let texto = partes[0];
    for (let i = 0; i < valores.length; i++) {
      texto += "$" + (i + 1) + partes[i + 1];
    }
    const r = await pg.query(texto, valores);
    return r.rows;
  };
}
