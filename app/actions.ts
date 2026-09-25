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

  // O gasto pertence ao mes da data dele. Se esse nao for o mes na tela, e
  // para la que voltamos: senao o lancamento some e parece que nao funcionou.
  const [a, m] = data.split("-").map(Number);
  redirect(
    Number.isFinite(a) && Number.isFinite(m) ? `/?ano=${a}&mes=${m}` : destino(fd)
  );
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
  const secao = String(fd.get("secao") ?? "").trim() || "Geral";

  const sql = db();
  await sql`
    update contas
       set valor = ${valor}, dia_vencimento = ${diaValido}, secao = ${secao}
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

/** Cria uma conta nova. Ela aparece no mes que voce estiver vendo e nos
 *  proximos, porque cada mes se monta com as contas ativas do momento. */
export async function novaConta(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const nome = String(fd.get("nome") ?? "").trim();
  if (nome === "") redirect(destino(fd, "erro=conta"));

  const secao = String(fd.get("secao") ?? "").trim() || "Geral";
  const tipo = String(fd.get("tipo") ?? "fixa") === "cartao" ? "cartao" : "fixa";
  const valor = tipo === "cartao" ? 0 : parseValor(fd.get("valor"));
  const diaBruto = String(fd.get("dia_vencimento") ?? "").trim();
  const dia = diaBruto === "" ? null : parseInteiro(diaBruto);
  const diaValido = dia != null && dia >= 1 && dia <= 31 ? dia : null;

  const sql = db();
  const [{ proxima }] = (await sql`
    select coalesce(max(ordem), 0) + 1 as proxima from contas
  `) as Array<{ proxima: number }>;

  const criada = (await sql`
    insert into contas (nome, valor, dia_vencimento, tipo, secao, ordem)
    values (${nome}, ${valor}, ${diaValido}, ${tipo}, ${secao}, ${proxima})
    on conflict (nome) do update set ativo = true
    returning id
  `) as Array<{ id: number }>;

  if (criada.length === 0) redirect(destino(fd, "erro=conta_existe"));

  revalidatePath("/");
  redirect(destino(fd));
}

/** Tira a conta de circulacao sem apagar o historico ja pago. */
export async function removerConta(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const id = parseInteiro(fd.get("id"));
  if (id == null) return;

  const sql = db();
  await sql`update contas set ativo = false where id = ${id}`;
  await sql`
    delete from contas_mes
     where conta_id = ${id} and pago = false
  `;

  revalidatePath("/");
  redirect(destino(fd));
}

/** Muda o previsto de UMA conta em UM mes. Campo vazio devolve o valor
 *  automatico: o do cadastro, para conta fixa, e a soma dos gastos, para
 *  cartao. */
export async function salvarPrevisto(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const ano = parseInteiro(fd.get("ano"));
  const mes = parseInteiro(fd.get("mes"));
  const contaId = parseInteiro(fd.get("conta_id"));
  if (ano == null || mes == null || contaId == null) return;

  const bruto = String(fd.get("previsto") ?? "").trim();
  const sql = db();

  if (bruto === "") {
    await sql`
      update contas_mes m
         set previsto_manual = false,
             previsto = case when c.tipo = 'cartao' then 0 else c.valor end
        from contas c
       where c.id = m.conta_id
         and m.conta_id = ${contaId}
         and m.ano = ${ano} and m.mes = ${mes}
    `;
  } else {
    await sql`
      update contas_mes
         set previsto = ${parseValor(bruto)}, previsto_manual = true
       where conta_id = ${contaId} and ano = ${ano} and mes = ${mes}
    `;
  }

  revalidatePath("/");
  redirect(destino(fd));
}

/** Guarda a renda do mes que esta na tela. Como o mes sem valor proprio herda
 *  o ultimo cadastrado, digitar uma vez ja vale para os meses seguintes. */
export async function salvarRenda(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const ano = parseInteiro(fd.get("ano"));
  const mes = parseInteiro(fd.get("mes"));
  if (ano == null || mes == null) return;

  const valor = parseValor(fd.get("renda"));

  await db()`
    insert into renda (ano, mes, valor)
    values (${ano}, ${mes}, ${valor})
    on conflict (ano, mes) do update set valor = excluded.valor
  `;

  revalidatePath("/");
  redirect(destino(fd));
}

/** Corrige o valor de um gasto ja lancado. */
export async function salvarGasto(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const id = parseInteiro(fd.get("id"));
  if (id == null) return;

  const valor = parseValor(fd.get("valor"));
  if (valor <= 0) redirect(destino(fd, "erro=gasto"));

  await db()`update gastos set valor = ${valor} where id = ${id}`;

  revalidatePath("/");
  redirect(destino(fd));
}
