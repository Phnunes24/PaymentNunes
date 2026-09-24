import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";

const COOKIE = "contas_sessao";
const UM_ANO = 60 * 60 * 24 * 365;

function segredo(): string {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || "";
}

function assinatura(): string {
  return createHmac("sha256", segredo())
    .update(`contas:${process.env.APP_PASSWORD || ""}`)
    .digest("hex");
}

function igual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export async function estaLogado(): Promise<boolean> {
  if (!process.env.APP_PASSWORD) return false;
  const valor = (await cookies()).get(COOKIE)?.value;
  if (!valor) return false;
  return igual(valor, assinatura());
}

/** Devolve null quando deu certo, ou a mensagem de erro. */
export async function entrar(senha: string): Promise<string | null> {
  const esperada = process.env.APP_PASSWORD;
  if (!esperada) {
    return "A senha ainda nao foi configurada. Defina APP_PASSWORD no Vercel.";
  }
  if (senha !== esperada) {
    return "Senha incorreta.";
  }
  (await cookies()).set(COOKIE, assinatura(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: UM_ANO,
  });
  return null;
}

export async function sair(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
