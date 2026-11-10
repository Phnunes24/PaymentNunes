"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, ensureSchema } from "@/lib/db";
import { entrar, sair, estaLogado } from "@/lib/auth";
import { parseValor, parseInteiro, hoje } from "@/lib/format";
import {
  apagarConta,
  criarConta,
  editarConta,
  type DadosConta,
} from "@/lib/data";

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

/** Le os campos de uma conta do formulario de criar ou de editar. */
function lerConta(fd: FormData): DadosConta {
  const tipo = String(fd.get("tipo") ?? "fixa") === "cartao" ? "cartao" : "fixa";
  const diaBruto = String(fd.get("dia_vencimento") ?? "").trim();
  const dia = diaBruto === "" ? null : parseInteiro(diaBruto);
  return {
    nome: String(fd.get("nome") ?? "").trim().slice(0, 60),
    secao: String(fd.get("secao") ?? "").trim().slice(0, 40) || "Geral",
    tipo,
    valor: tipo === "cartao" ? 0 : parseValor(fd.get("valor")),
    dia_vencimento: dia != null && dia >= 1 && dia <= 31 ? dia : null,
  };
}

/** Muda nome, secao, tipo, valor e vencimento de uma conta. */
export async function salvarConta(fd: FormData): Promise<void> {
  await exigirLogin();

  const id = parseInteiro(fd.get("id"));
  if (id == null) return;

  if (!(await editarConta(id, lerConta(fd)))) {
    redirect(destino(fd, "erro=conta_existe"));
  }

  revalidatePath("/");
  redirect(destino(fd));
}

export async function novaConta(fd: FormData): Promise<void> {
  await exigirLogin();

  const dados = lerConta(fd);
  if (dados.nome === "") redirect(destino(fd, "erro=conta"));

  if (!(await criarConta(dados))) {
    redirect(destino(fd, "erro=conta_existe"));
  }

  revalidatePath("/");
  redirect(destino(fd));
}

export async function apagarContaAction(fd: FormData): Promise<void> {
  await exigirLogin();

  const id = parseInteiro(fd.get("id"));
  if (id == null) return;

  await apagarConta(id);

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
