import { redirect } from "next/navigation";
import { estaLogado } from "@/lib/auth";
import { entrarAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  if (await estaLogado()) redirect("/");
  const { erro } = await searchParams;

  return (
    <main className="login">
      <section>
        <h1>Minhas contas</h1>
        <p>Esta página é particular. Digite a senha para entrar.</p>
        {erro ? <div className="erro">{erro}</div> : null}
        <form action={entrarAction}>
          <input
            type="password"
            name="senha"
            placeholder="senha"
            autoComplete="current-password"
            autoFocus
            required
          />
          <button className="btn" type="submit">
            Entrar
          </button>
        </form>
      </section>
    </main>
  );
}
