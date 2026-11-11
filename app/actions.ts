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
  editarGasto,
  salvarLimites,
  CATEGORIAS,
  type DadosConta,
  type DadosGasto,
} from "@/lib/data";
import {
  desconectarBancos,
  salvarCredenciais,
  salvarMapa,
  sincronizarBancos,
} from "@/lib/bancos";

async function exigirLogin(): Promise<void> {
  if (!(await estaLogado())) redirect("/login");
}

const TELAS = new Set([
  "/",
  "/contas",
  "/gastos",
  "/analise",
  "/investimentos",
  "/ajustes",
]);

/** Para onde voltar depois da acao: a mesma tela, no mesmo mes. O mes pode
 *  ser trocado por quem chama (gasto lancado com data de outro mes). */
function destino(
  fd: FormData,
  extra?: string,
  noMes?: { ano: number; mes: number }
): string {
  const volta = String(fd.get("volta") ?? "/");
  const caminho = TELAS.has(volta) ? volta : "/";
  const ano = noMes?.ano ?? parseInteiro(fd.get("ano"));
  const mes = noMes?.mes ?? parseInteiro(fd.get("mes"));
  const partes: string[] = [];
  if (ano != null && mes != null) partes.push(`ano=${ano}`, `mes=${mes}`);
  if (extra) partes.push(extra);
  return partes.length ? `${caminho}?${partes.join("&")}` : caminho;
}

/** Mes de uma data aaaa-mm-dd, ou undefined se ela nao estiver nesse formato. */
function mesDaData(data: string): { ano: number; mes: number } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return undefined;
  const [ano, mes] = data.split("-").map(Number);
  return mes >= 1 && mes <= 12 ? { ano, mes } : undefined;
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

  revalidatePath("/", "layout");
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

  revalidatePath("/", "layout");
  redirect(destino(fd));
}

/** Le os campos de um gasto do formulario de lancar ou de editar. */
function lerGasto(fd: FormData): DadosGasto {
  const dataBruta = String(fd.get("data") ?? "").trim();
  const categoria = String(fd.get("categoria") ?? "");
  return {
    descricao: String(fd.get("descricao") ?? "").trim().slice(0, 80),
    valor: parseValor(fd.get("valor")),
    data: mesDaData(dataBruta) ? dataBruta : hoje().iso,
    categoria: CATEGORIAS.includes(categoria) ? categoria : "Outros",
    pago_com: String(fd.get("pago_com") ?? "").trim().slice(0, 60) || "Pix",
  };
}

export async function novoGasto(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const g = lerGasto(fd);
  if (g.descricao === "" || g.valor <= 0) redirect(destino(fd, "erro=gasto"));

  await db()`
    insert into gastos (data, descricao, categoria, pago_com, valor)
    values (${g.data}, ${g.descricao}, ${g.categoria}, ${g.pago_com}, ${g.valor})
  `;

  revalidatePath("/", "layout");

  // O gasto pertence ao mes da data dele. Se esse nao for o mes na tela, e
  // para la que voltamos: senao o lancamento some e parece que nao funcionou.
  redirect(destino(fd, undefined, mesDaData(g.data)));
}

export async function excluirGasto(fd: FormData): Promise<void> {
  await exigirLogin();
  await ensureSchema();

  const id = parseInteiro(fd.get("id"));
  if (id == null) return;

  await db()`delete from gastos where id = ${id}`;

  revalidatePath("/", "layout");
  redirect(destino(fd));
}

/** Le os campos de uma conta do formulario de criar ou de editar. */
function lerConta(fd: FormData): DadosConta {
  const tipo = String(fd.get("tipo") ?? "fixa") === "cartao" ? "cartao" : "fixa";
  const diaBruto = String(fd.get("dia_vencimento") ?? "").trim();
  const dia = diaBruto === "" ? null : parseInteiro(diaBruto);

  // Parcelas: o formulario diz o total e qual e a parcela do mes que esta na
  // tela. Daqui sai o mes da primeira, que e o que fica guardado.
  const total = parseInteiro(fd.get("parcelas"));
  const atual = parseInteiro(fd.get("parcela_atual"), 1) ?? 1;
  const agora = hoje();
  const anoTela = parseInteiro(fd.get("ano"), agora.ano) ?? agora.ano;
  const mesTela = parseInteiro(fd.get("mes"), agora.mes) ?? agora.mes;
  const parcelada =
    tipo === "fixa" &&
    total != null &&
    total >= 1 &&
    total <= 600 &&
    atual >= 1 &&
    atual <= total;

  return {
    nome: String(fd.get("nome") ?? "").trim().slice(0, 60),
    secao: String(fd.get("secao") ?? "").trim().slice(0, 40) || "Geral",
    tipo,
    valor: tipo === "cartao" ? 0 : parseValor(fd.get("valor")),
    dia_vencimento: dia != null && dia >= 1 && dia <= 31 ? dia : null,
    dia_fechamento: parseInteiro(fd.get("dia_fechamento")),
    parcelas: parcelada ? total : null,
    parcela_inicio: parcelada ? anoTela * 12 + mesTela - (atual - 1) : null,
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

  revalidatePath("/", "layout");
  redirect(destino(fd));
}

export async function novaConta(fd: FormData): Promise<void> {
  await exigirLogin();

  const dados = lerConta(fd);
  if (dados.nome === "") redirect(destino(fd, "erro=conta"));

  if (!(await criarConta(dados))) {
    redirect(destino(fd, "erro=conta_existe"));
  }

  revalidatePath("/", "layout");
  redirect(destino(fd));
}

export async function apagarContaAction(fd: FormData): Promise<void> {
  await exigirLogin();

  const id = parseInteiro(fd.get("id"));
  if (id == null) return;

  await apagarConta(id);

  revalidatePath("/", "layout");
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

  revalidatePath("/", "layout");
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

  revalidatePath("/", "layout");
  redirect(destino(fd));
}

/** Corrige um gasto ja lancado: descricao, valor, data, categoria e forma. */
export async function salvarGasto(fd: FormData): Promise<void> {
  await exigirLogin();

  const id = parseInteiro(fd.get("id"));
  if (id == null) return;

  const g = lerGasto(fd);
  if (g.descricao === "" || g.valor <= 0) redirect(destino(fd, "erro=gasto"));

  await editarGasto(id, g);

  revalidatePath("/", "layout");
  // Mudou a data para outro mes: a tela vai junto, senao o gasto some.
  redirect(destino(fd, undefined, mesDaData(g.data)));
}

/** Guarda o limite de gasto de cada categoria. Campo vazio tira o limite. */
export async function salvarLimitesAction(fd: FormData): Promise<void> {
  await exigirLogin();

  const limites = new Map<string, number>();
  for (const categoria of CATEGORIAS) {
    const bruto = fd.get(`limite_${categoria}`);
    if (bruto != null) limites.set(categoria, parseValor(bruto));
  }
  await salvarLimites(limites);

  revalidatePath("/", "layout");
  redirect(destino(fd));
}

/** Guarda as chaves do Meu Pluggy e ja faz a primeira sincronizacao. */
export async function salvarBancosAction(fd: FormData): Promise<void> {
  await exigirLogin();

  const clientId = String(fd.get("client_id") ?? "").trim();
  const clientSecret = String(fd.get("client_secret") ?? "").trim();
  const itens = String(fd.get("itens") ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f-]{20,}$/i.test(s));
  if (clientId === "" || itens.length === 0) {
    redirect(destino(fd, "erro=bancos"));
  }

  await salvarCredenciais({ clientId, clientSecret, itens });
  await sincronizarBancos();

  revalidatePath("/", "layout");
  redirect(destino(fd));
}

export async function sincronizarAgoraAction(fd: FormData): Promise<void> {
  await exigirLogin();
  await sincronizarBancos();
  revalidatePath("/", "layout");
  redirect(destino(fd));
}

/** Liga cada cartao do banco a um cartao cadastrado aqui, ou desliga a
 *  importacao de uma conta do banco. */
export async function salvarCartoesBancoAction(fd: FormData): Promise<void> {
  await exigirLogin();

  const mapa: Record<string, string> = {};
  fd.forEach((valor, campo) => {
    if (campo.startsWith("mapa_") && typeof valor === "string" && valor !== "") {
      mapa[campo.slice(5)] = valor;
    }
  });
  await salvarMapa(mapa);

  revalidatePath("/", "layout");
  redirect(destino(fd));
}

export async function desconectarBancosAction(fd: FormData): Promise<void> {
  await exigirLogin();
  await desconectarBancos();
  revalidatePath("/", "layout");
  redirect(destino(fd));
}
