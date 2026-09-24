"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, ensureSchema } from "@/lib/db";
import { entrar, sair, estaLogado } from "@/lib/auth";
import { parseValor, parseInteiro, hoje } from "@/lib/format";

async function exigirLogin(): Promise<void> {
  if (!(await estaLogado())) redirect("/login");
}

function destino(fd: FormData, extra?: string): string {
  const ano = fd.get("ano");
  const mes = fd.get("mes");
  const partes: string[] = [];
  if (ano && mes) partes.push(`ano=${ano}`, `mes=${mes}`);
  if (extra) partes.push(extra);
  return partes.length ? `/?${partes.join("&")}` : "/";
}

export async function entrarAction(fd: FormData): Promise<void> {
  const erro = await entrar(String(fd.get("senha") ?? ""));
  if (erro) redirect(`/login?erro=${encodeURIComponent(erro)}`);
  redirect("/");
}

export async function sairAction(): Promise<void> {
  await sair();
  redirect("/login");
}

export async function pagarConta(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const ano = parseInteiro(fd.get("ano"));
  const mes = parseInteiro(fd.get("mes"));
  const contaId = parseInteiro(fd.get("conta_id"));
  if (ano == null || mes == null || contaId == null) return;

  const valorBruto = String(fd.get("valor_pago") ?? "").trim();
  const valor = valorBruto === "" ? null : parseValor(valorBruto);
  const dataBruta = String(fd.get("data_pgto") ?? "").trim();
  const data = dataBruta === "" ? hoje().iso : dataBruta;

  await db()`
    update contas_mes
       set pago = true, valor_pago = ${valor}, data_pgto = ${data}
     where ano = ${ano} and mes = ${mes} and conta_id = ${contaId}
  `;

  revalidatePath("/");
  redirect(destino(fd));
}

export async function desfazerPagamento(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const ano = parseInteiro(fd.get("ano"));
  const mes = parseInteiro(fd.get("mes"));
  const contaId = parseInteiro(fd.get("conta_id"));
  if (ano == null || mes == null || contaId == null) return;

  await db()`
    update contas_mes
       set pago = false, valor_pago = null, data_pgto = null
     where ano = ${ano} and mes = ${mes} and conta_id = ${contaId}
  `;

  revalidatePath("/");
  redirect(destino(fd));
}

export async function novoGasto(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const descricao = String(fd.get("descricao") ?? "").trim();
  const valor = parseValor(fd.get("valor"));
  const data = String(fd.get("data") ?? "").trim() || hoje().iso;
  const categoria = String(fd.get("categoria") ?? "Outros");
  const pagoCom = String(fd.get("pago_com") ?? "Pix");

  if (descricao === "" || valor <= 0) redirect(destino(fd, "erro=gasto"));

  await db()`
    insert into gastos (data, descricao, categoria, pago_com, valor)
    values (${data}, ${descricao}, ${categoria}, ${pagoCom}, ${valor})
  `;

  revalidatePath("/");
  redirect(destino(fd));
}

export async function excluirGasto(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const id = parseInteiro(fd.get("id"));
  if (id == null) return;

  await db()`delete from gastos where id = ${id}`;

  revalidatePath("/");
  redirect(destino(fd));
}

/** Muda o valor e o vencimento de uma conta. O novo valor vale deste mes em
 *  diante, e so nas contas que ainda nao foram marcadas como pagas. */
export async function salvarConta(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const id = parseInteiro(fd.get("id"));
  if (id == null) return;

  const valor = parseValor(fd.get("valor"));
  const diaBruto = String(fd.get("dia_vencimento") ?? "").trim();
  const dia = diaBruto === "" ? null : parseInteiro(diaBruto);
  const diaValido = dia != null && dia >= 1 && dia <= 31 ? dia : null;

  const sql = db();
  await sql`
    update contas
       set valor = ${valor}, dia_vencimento = ${diaValido}
     where id = ${id}
  `;

  const { ano, mes } = hoje();
  await sql`
    update contas_mes m
       set previsto = ${valor}
      from contas c
     where c.id = m.conta_id
       and m.conta_id = ${id}
       and c.tipo = 'fixa'
       and m.pago = false
       and (m.ano > ${ano} or (m.ano = ${ano} and m.mes >= ${mes}))
  `;

  revalidatePath("/");
  redirect(destino(fd));
}
