/**
 * Importacao automatica dos bancos: guarda as chaves do Meu Pluggy, puxa as
 * transacoes e transforma em gasto (ou em conta paga). Roda no cron diario e
 * no botao "Sincronizar agora".
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";
import { db, ensureSchema } from "./db";
import { listarContas } from "./data";
import { hoje } from "./format";
import { casarCartao } from "./regras";
import {
  acharMesmoGasto,
  autenticar,
  bancoDe,
  buscarContas,
  buscarFaturas,
  buscarInvestimentos,
  buscarItem,
  buscarTransacoes,
  chaveDe,
  cicloDoBanco,
  comprasEstornadas,
  dataBrasil,
  decidir,
  donosDe,
  faturaAberta,
  indiceDaData,
  limparDescricao,
  movimentosInternos,
  nomeDaConta,
  OPERACOES_TRANSFERENCIA,
  rotuloDoCartao,
  textoDoCartao,
  type Decisao,
  type GastoSolto,
  type Lida,
  type PluggyInvestimento,
} from "./pluggy";

export const NAO_IMPORTAR = "__ignorar";

export type ContaDoBanco = {
  id: string;
  banco: string;
  nome: string;
  cartao: boolean;
  /** Cartao: com que nome a compra entra quando ele nao casa com nenhum
   *  cartao cadastrado, e o texto usado para tentar casar. */
  rotulo?: string;
  texto?: string;
  /** Cartao: dia em que a fatura fecha e vence, segundo o banco. */
  fechamento?: number | null;
  vencimento?: number | null;
  /** Conta: saldo disponivel. */
  saldo?: number;
};

export type ResumoBancos = {
  quando: string;
  novos: number;
  vinculados: number;
  /** Pix, transferencias e boletos guardados para voce dizer o que sao. */
  guardados: number;
  ignorados: number;
  bancos: Array<{
    nome: string;
    status: string;
    expira: string | null;
    atualizado: string | null;
    erro: string | null;
  }>;
  erro: string | null;
};

export type ConfigBancos = {
  configurado: boolean;
  clientId: string;
  temSecret: boolean;
  /** Ha um secret guardado, mas ele nao abre com a chave atual do servidor. */
  secretIlegivel: boolean;
  itens: string[];
  /** Contas do banco vistas na ultima sincronizacao. */
  contas: ContaDoBanco[];
  /** Conta do banco -> nome do cartao cadastrado aqui, ou NAO_IMPORTAR. */
  mapa: Record<string, string>;
  resumo: ResumoBancos | null;
};

export type Importado = {
  acao: string;
  descricao: string;
  valor: number;
  data: string;
};

function json<T>(texto: string | undefined, padrao: T): T {
  if (!texto) return padrao;
  try {
    return JSON.parse(texto) as T;
  } catch {
    return padrao;
  }
}

// ------------------------------------------------- client secret cifrado ---
// O Client Secret fica no banco cifrado com AES-256-GCM. A chave sai do
// AUTH_SECRET do servidor (ou da senha do app, se ele nao existir) e nunca vai
// para o banco: quem tiver so uma copia do banco nao consegue usar o secret.
const PREFIXO = "v1:";
const ERRO_SECRET =
  "O Client Secret guardado não abre mais (a senha do app ou o AUTH_SECRET mudou). Cole o Client Secret de novo em Trocar chaves.";

function chaveCripto(): Buffer {
  const base = process.env.AUTH_SECRET || process.env.APP_PASSWORD || "";
  if (!base) {
    throw new Error("Falta AUTH_SECRET ou APP_PASSWORD para proteger o Client Secret.");
  }
  return Buffer.from(hkdfSync("sha256", base, "paymentnunes", "pluggy-client-secret", 32));
}

export function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chaveCripto(), iv);
  const corpo = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return PREFIXO + Buffer.concat([iv, c.getAuthTag(), corpo]).toString("base64");
}

/** Texto do secret, ou null se nao abre com a chave atual (ou foi mexido).
 *  Valor sem prefixo e de antes da cifra: volta como esta. */
export function decifrar(guardado: string): string | null {
  if (!guardado.startsWith(PREFIXO)) return guardado;
  try {
    const bruto = Buffer.from(guardado.slice(PREFIXO.length), "base64");
    const d = createDecipheriv("aes-256-gcm", chaveCripto(), bruto.subarray(0, 12));
    d.setAuthTag(bruto.subarray(12, 28));
    return Buffer.concat([d.update(bruto.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

async function lerTudo(): Promise<Map<string, string>> {
  await ensureSchema();
  const linhas = (await db()`
    select chave, valor from config where chave like 'bancos_%'
  `) as Array<{ chave: string; valor: string }>;
  return new Map(linhas.map((l) => [l.chave, l.valor]));
}

async function gravar(chave: string, valor: string): Promise<void> {
  await db()`
    insert into config (chave, valor) values (${chave}, ${valor})
    on conflict (chave) do update set valor = excluded.valor
  `;
}

export async function lerConfigBancos(): Promise<ConfigBancos> {
  const c = await lerTudo();
  const itens = (c.get("bancos_itens") ?? "").split(",").filter(Boolean);
  const clientId = c.get("bancos_client_id") ?? "";
  const guardado = c.get("bancos_client_secret") ?? "";
  const legivel = guardado !== "" && decifrar(guardado) !== null;
  return {
    configurado: Boolean(clientId && legivel && itens.length > 0),
    clientId,
    temSecret: legivel,
    secretIlegivel: guardado !== "" && !legivel,
    itens,
    contas: json<ContaDoBanco[]>(c.get("bancos_contas"), []),
    mapa: json<Record<string, string>>(c.get("bancos_mapa"), {}),
    resumo: json<ResumoBancos | null>(c.get("bancos_resumo"), null),
  };
}

/** Guarda as chaves. Secret vazio mantem o que ja estava salvo. A primeira
 *  vez marca o comeco do mes como ponto de partida: nada antes disso entra. */
export async function salvarCredenciais(dados: {
  clientId: string;
  clientSecret: string;
  itens: string[];
}): Promise<void> {
  const c = await lerTudo();
  await gravar("bancos_client_id", dados.clientId);
  if (dados.clientSecret) {
    await gravar("bancos_client_secret", cifrar(dados.clientSecret));
  }
  await gravar("bancos_itens", [...new Set(dados.itens)].join(","));
  if (!c.get("bancos_desde")) {
    const { ano, mes } = hoje();
    await gravar("bancos_desde", `${ano}-${String(mes).padStart(2, "0")}-01`);
  }
}

/** Guarda em que cartao daqui cai cada cartao do banco, e ja corrige as
 *  compras que tinham entrado com o nome provisorio. */
export async function salvarMapa(mapa: Record<string, string>): Promise<void> {
  const c = await lerTudo();
  await gravar("bancos_mapa", JSON.stringify(mapa));
  const nomesCartoes = (await listarContas())
    .filter((x) => x.tipo === "cartao")
    .map((x) => x.nome);
  await reetiquetar(
    json<ContaDoBanco[]>(c.get("bancos_contas"), []),
    mapa,
    nomesCartoes
  );
}

/**
 * Compra de cartao que nao casou com nenhum cartao cadastrado entra com um
 * nome provisorio ("C6 Bank final 0722"). Quando o cartao passa a ter dono,
 * porque voce escolheu ou porque criou um cartao com o nome do banco, as
 * compras ja importadas com o nome provisorio mudam para ele.
 */
/** Cartao cadastrado aqui que corresponde a um cartao do banco: o que voce
 *  escolheu, ou o que casa pelo nome. */
function donoDoCartao(
  conta: ContaDoBanco,
  mapa: Record<string, string>,
  nomesCartoes: string[]
): string | null {
  if (!conta.cartao) return null;
  const escolha = mapa[conta.id];
  if (escolha === NAO_IMPORTAR) return null;
  if (escolha && nomesCartoes.includes(escolha)) return escolha;
  return casarCartao(conta.texto ?? `${conta.nome} ${conta.banco}`, nomesCartoes);
}

async function reetiquetar(
  contas: ContaDoBanco[],
  mapa: Record<string, string>,
  nomesCartoes: string[]
): Promise<void> {
  const sql = db();
  for (const conta of contas) {
    if (!conta.rotulo) continue;
    const dono = donoDoCartao(conta, mapa, nomesCartoes);
    if (!dono || dono === conta.rotulo) continue;
    await sql`
      update gastos set pago_com = ${dono}
       where origem = 'banco' and pago_com = ${conta.rotulo}
    `;
  }
}

/** O cartao cadastrado aprende com o banco em que dia a fatura fecha e
 *  vence. So preenche o que estiver vazio: o que voce digitou fica. */
async function aprenderCiclos(
  contas: ContaDoBanco[],
  mapa: Record<string, string>,
  nomesCartoes: string[]
): Promise<void> {
  const sql = db();
  for (const conta of contas) {
    if (conta.fechamento == null && conta.vencimento == null) continue;
    const dono = donoDoCartao(conta, mapa, nomesCartoes);
    if (!dono) continue;
    await sql`
      update contas
         set dia_fechamento = coalesce(dia_fechamento, ${conta.fechamento ?? null}::int),
             dia_vencimento = coalesce(dia_vencimento, ${conta.vencimento ?? null}::int)
       where ativo and tipo = 'cartao' and nome = ${dono}
    `;
  }
}

/** Troca os investimentos guardados pelos que o banco acabou de informar e
 *  tira o retrato do dia: total investido e saldo em conta. */
async function guardarInvestimentos(
  porItem: Map<string, { banco: string; lista: PluggyInvestimento[] }>,
  contas: ContaDoBanco[],
  hojeIso: string
): Promise<void> {
  if (porItem.size === 0) return;
  const sql = db();
  const data = (valor: string | null | undefined) => {
    const s = (valor ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };
  const numero = (valor: number | null | undefined) =>
    typeof valor === "number" && Number.isFinite(valor) ? valor : null;

  for (const [item, { banco, lista }] of porItem) {
    const ids = lista.map((i) => i.id);
    await sql`
      delete from investimentos
       where item = ${item} and not (id = any(${ids}::text[]))
    `;
    if (lista.length === 0) continue;
    await sql`
      insert into investimentos
             (id, item, banco, nome, tipo, subtipo, situacao, saldo, bruto,
              aplicado, lucro, taxa, indexador, taxa_fixa, vencimento, emissor,
              atualizado)
      select t.id, ${item}, ${banco}, t.nome, t.tipo, t.subtipo, t.situacao,
             coalesce(t.saldo, 0), t.bruto, t.aplicado, t.lucro, t.taxa,
             t.indexador, t.taxa_fixa, t.vencimento::date, t.emissor, now()
        from unnest(
               ${ids}::text[],
               ${lista.map((i) => (i.name ?? "Investimento").slice(0, 120))}::text[],
               ${lista.map((i) => i.type ?? "OTHER")}::text[],
               ${lista.map((i) => i.subtype ?? null)}::text[],
               ${lista.map((i) => i.status ?? null)}::text[],
               ${lista.map((i) => numero(i.balance))}::numeric[],
               ${lista.map((i) => numero(i.amount))}::numeric[],
               ${lista.map((i) => numero(i.amountOriginal))}::numeric[],
               ${lista.map((i) => numero(i.amountProfit))}::numeric[],
               ${lista.map((i) => numero(i.rate))}::numeric[],
               ${lista.map((i) => i.rateType ?? null)}::text[],
               ${lista.map((i) => numero(i.fixedAnnualRate))}::numeric[],
               ${lista.map((i) => data(i.dueDate))}::text[],
               ${lista.map((i) => (i.issuer ?? null))}::text[]
             ) as t(id, nome, tipo, subtipo, situacao, saldo, bruto, aplicado,
                    lucro, taxa, indexador, taxa_fixa, vencimento, emissor)
      on conflict (id) do update
         set item = excluded.item, banco = excluded.banco, nome = excluded.nome,
             tipo = excluded.tipo, subtipo = excluded.subtipo,
             situacao = excluded.situacao, saldo = excluded.saldo,
             bruto = excluded.bruto, aplicado = excluded.aplicado,
             lucro = excluded.lucro, taxa = excluded.taxa,
             indexador = excluded.indexador, taxa_fixa = excluded.taxa_fixa,
             vencimento = excluded.vencimento, emissor = excluded.emissor,
             atualizado = excluded.atualizado
    `;
  }

  const emConta = contas
    .filter((c) => !c.cartao)
    .reduce((soma, c) => soma + (c.saldo ?? 0), 0);
  await sql`
    insert into patrimonio (data, investido, em_conta)
    select ${hojeIso}::date, coalesce(sum(saldo), 0), ${emConta}
      from investimentos
     where coalesce(situacao, 'ACTIVE') <> 'TOTAL_WITHDRAWAL'
    on conflict (data) do update
       set investido = excluded.investido, em_conta = excluded.em_conta
  `;
}

/** Apaga as chaves. O registro do que ja foi importado fica, para nada
 *  entrar em dobro se voce conectar de novo. */
export async function desconectarBancos(): Promise<void> {
  await ensureSchema();
  await db()`delete from config where chave like 'bancos_%' and chave <> 'bancos_desde'`;
}

export async function ultimosImportados(limite = 15): Promise<Importado[]> {
  await ensureSchema();
  const linhas = (await db()`
    select acao, descricao, valor, data from importados
     order by criado_em desc, data desc
     limit ${limite}
  `) as Array<Record<string, unknown>>;
  return linhas.map((l) => ({
    acao: String(l.acao),
    descricao: String(l.descricao ?? ""),
    valor: Number(l.valor ?? 0),
    data: l.data instanceof Date ? l.data.toISOString().slice(0, 10) : String(l.data ?? "").slice(0, 10),
  }));
}

function menosDias(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Puxa as transacoes de todos os bancos conectados e lanca o que for novo.
 * Nunca lanca a mesma transacao duas vezes, nem a que voce apagou da lista:
 * toda transacao vista fica registrada em `importados`.
 */
export async function sincronizarBancos(): Promise<ResumoBancos> {
  const resumo: ResumoBancos = {
    quando: new Date().toISOString(),
    novos: 0,
    vinculados: 0,
    guardados: 0,
    ignorados: 0,
    bancos: [],
    erro: null,
  };

  try {
    const c = await lerTudo();
    const clientId = c.get("bancos_client_id");
    const guardado = c.get("bancos_client_secret");
    const itens = (c.get("bancos_itens") ?? "").split(",").filter(Boolean);
    if (!clientId || !guardado || itens.length === 0) {
      throw new Error("Bancos ainda não configurados.");
    }
    const secret = decifrar(guardado);
    if (secret === null) throw new Error(ERRO_SECRET);
    // Secret salvo antes da cifra existir: passa a ficar cifrado agora.
    if (!guardado.startsWith(PREFIXO)) {
      await gravar("bancos_client_secret", cifrar(secret));
    }
    const mapa = json<Record<string, string>>(c.get("bancos_mapa"), {});
    const { iso: hojeIso } = hoje();
    const desde = c.get("bancos_desde") ?? hojeIso.slice(0, 8) + "01";
    const janela = [desde, menosDias(hojeIso, 45)].sort()[1];

    const apiKey = await autenticar(clientId, secret);

    const lidas: Lida[] = [];
    const vistas: ContaDoBanco[] = [];
    const donos = new Set<string>();
    // Em que mes vence a fatura aberta de cada cartao, e cada fatura fechada.
    const faturaAbertaDe = new Map<string, number | null>();
    const vencimentoDaFatura = new Map<string, number>();
    const investimentos = new Map<string, { banco: string; lista: PluggyInvestimento[] }>();
    await Promise.all(
      itens.map(async (itemId) => {
        try {
          const item = await buscarItem(apiKey, itemId);
          const contas = await buscarContas(apiKey, itemId);
          const banco = bancoDe(contas, item.connector?.name);
          for (const dono of donosDe(contas)) donos.add(dono);
          resumo.bancos.push({
            nome: banco,
            status: item.status,
            expira: item.consentExpiresAt ?? null,
            atualizado: item.lastUpdatedAt ?? null,
            erro: item.error?.message ?? item.error?.code ?? null,
          });
          await Promise.all(
            contas.map(async (conta) => {
              const cartao = conta.type === "CREDIT";
              vistas.push({
                id: conta.id,
                banco,
                nome: nomeDaConta(conta),
                cartao,
                ...(cartao
                  ? {
                      rotulo: rotuloDoCartao(conta, banco),
                      texto: textoDoCartao(conta, banco),
                      ...cicloDoBanco(conta),
                    }
                  : typeof conta.balance === "number"
                    ? { saldo: conta.balance }
                    : {}),
              });
              // Cartao olha 45 dias para tras mesmo no primeiro mes: a fatura
              // aberta comecou antes do dia 1.
              const txs = await buscarTransacoes(
                apiKey,
                conta.id,
                cartao ? menosDias(hojeIso, 45) : janela
              );
              for (const tx of txs) {
                lidas.push({ chave: chaveDe(tx), tx, conta, banco });
              }
              if (cartao) {
                faturaAbertaDe.set(conta.id, faturaAberta(conta, hojeIso));
                if (txs.some((t) => t.creditCardMetadata?.billId)) {
                  try {
                    for (const f of await buscarFaturas(apiKey, conta.id)) {
                      const vence = String(f.dueDate ?? "").slice(0, 10);
                      if (/^\d{4}-\d{2}-\d{2}$/.test(vence)) {
                        vencimentoDaFatura.set(f.id, indiceDaData(vence));
                      }
                    }
                  } catch {
                    // sem a lista de faturas, vale a regra do fechamento
                  }
                }
              }
            })
          );
          try {
            investimentos.set(itemId, {
              banco,
              lista: await buscarInvestimentos(apiKey, itemId),
            });
          } catch {
            // banco que nao informa investimentos: fica o que ja estava guardado
          }
        } catch (e) {
          resumo.bancos.push({
            nome: `Item ${itemId.slice(0, 8)}`,
            status: "ERRO",
            expira: null,
            atualizado: null,
            erro: e instanceof Error ? e.message : String(e),
          });
        }
      })
    );
    await gravar("bancos_contas", JSON.stringify(vistas));

    const sql = db();
    const chaves = [...new Set(lidas.map((l) => l.chave))];
    const jaVistas = new Set(
      chaves.length === 0
        ? []
        : ((await sql`
            select chave from importados where chave = any(${chaves}::text[])
          `) as Array<{ chave: string }>).map((r) => r.chave)
    );

    const internos = movimentosInternos(lidas);
    const nomesCartoes = (await listarContas())
      .filter((x) => x.tipo === "cartao")
      .map((x) => x.nome);
    await reetiquetar(vistas, mapa, nomesCartoes);
    await aprenderCiclos(vistas, mapa, nomesCartoes);

    // Em que fatura a compra cai, segundo o banco: a fatura fechada em que
    // ela esta ou, se ainda nao fechou, a fatura aberta do cartao.
    const faturaDe = (l: Lida): number | null => {
      if (l.conta.type !== "CREDIT") return null;
      const fechada = l.tx.creditCardMetadata?.billId;
      if (fechada && vencimentoDaFatura.has(fechada)) {
        return vencimentoDaFatura.get(fechada) ?? null;
      }
      return l.tx.status === "PENDING" ? (faturaAbertaDe.get(l.conta.id) ?? null) : null;
    };

    // Compras ja importadas ganham (ou corrigem) a fatura informada pelo banco.
    const refazer = { chave: [] as string[], fatura: [] as number[] };
    for (const l of lidas) {
      const fatura = jaVistas.has(l.chave) ? faturaDe(l) : null;
      if (fatura != null) {
        refazer.chave.push(l.chave);
        refazer.fatura.push(fatura);
      }
    }
    if (refazer.chave.length > 0) {
      await sql`
        update gastos g set fatura = t.fatura
          from unnest(${refazer.chave}::text[], ${refazer.fatura}::int[]) as t(chave, fatura)
         where g.externo = t.chave and g.fatura is distinct from t.fatura
      `;
    }

    // Estorno que chegou depois da compra: a compra ja lancada sai da lista.
    const estornadas = comprasEstornadas(lidas);
    for (const [compra, estorno] of estornadas) {
      if (jaVistas.has(compra) && !jaVistas.has(estorno)) {
        await sql`delete from gastos where externo = ${compra}`;
        await sql`
          update importados set acao = 'ignorado: compra estornada'
           where chave = ${compra}
        `;
      }
    }

    const unicas = new Map<string, Lida>();
    for (const l of lidas) if (!jaVistas.has(l.chave)) unicas.set(l.chave, l);
    const novas = [...unicas.values()].sort((a, b) =>
      a.tx.date < b.tx.date ? -1 : a.tx.date > b.tx.date ? 1 : 0
    );

    type Plano = { l: Lida; d: Decisao };
    const planos: Plano[] = [];
    for (const l of novas) {
      const data = dataBrasil(l.tx.date);
      // Nada de antes do ponto de partida. A API filtra pela data em UTC, e
      // a compra das 23h do ultimo dia do mes passaria. A excecao e a compra
      // que esta na fatura aberta do cartao: sem ela a fatura fica incompleta.
      const naFaturaAberta = l.conta.type === "CREDIT" && l.tx.status === "PENDING";
      if (data < desde && !naFaturaAberta) continue;
      // Parcela de cartao que ainda vai vencer entra quando o dia dela chegar.
      if (l.conta.type === "CREDIT" && data > hojeIso) continue;
      const escolha = mapa[l.conta.id];
      let d: Decisao;
      if (escolha === NAO_IMPORTAR) {
        d = { acao: "ignorar", motivo: "conta marcada para não importar" };
      } else if (estornadas.has(l.chave)) {
        d = { acao: "ignorar", motivo: "compra estornada" };
      } else if (internos.has(l.chave)) {
        d = { acao: "ignorar", motivo: "entre suas contas ou pagamento de fatura" };
      } else if (
        l.conta.type === "BANK" &&
        l.tx.type === "DEBIT" &&
        OPERACOES_TRANSFERENCIA.has(l.tx.operationType ?? "") &&
        data > menosDias(hojeIso, 2)
      ) {
        // Pix e transferencia recentes esperam 2 dias: o outro banco pode
        // ainda nao ter mostrado a entrada que prova que era para voce mesmo.
        continue;
      } else {
        d = decidir(
          l.tx,
          l.conta,
          nomesCartoes,
          hojeIso,
          escolha && nomesCartoes.includes(escolha) ? escolha : null,
          l.banco,
          [...donos]
        );
      }
      // Saida agendada volta a ser olhada quando acontecer.
      if (d.acao === "ignorar" && d.motivo === "agendado") continue;
      planos.push({ l, d });
    }

    const gastos = planos.filter(
      (p): p is { l: Lida; d: Extract<Decisao, { acao: "gasto" }> } => p.d.acao === "gasto"
    );

    let soltos: GastoSolto[] = [];
    if (gastos.length > 0) {
      const datas = gastos.map((g) => g.d.data).sort();
      soltos = ((await sql`
        select id, data, valor, pago_com from gastos
         where externo is null
           and data between ${menosDias(datas[0], 3)}::date
                        and ${menosDias(datas[datas.length - 1], -3)}::date
      `) as Array<Record<string, unknown>>).map((r) => ({
        id: Number(r.id),
        data: r.data instanceof Date ? r.data.toISOString().slice(0, 10) : String(r.data).slice(0, 10),
        valor: Number(r.valor),
        pago_com: String(r.pago_com),
      }));
    }

    const reg = { chave: [] as string[], acao: [] as string[], desc: [] as string[], valor: [] as number[], data: [] as string[] };
    const ins = { data: [] as string[], desc: [] as string[], cat: [] as string[], pago: [] as string[], valor: [] as number[], chave: [] as string[], fatura: [] as Array<number | null> };
    const registrar = (l: Lida, acao: string, desc: string, valor: number, data: string) => {
      reg.chave.push(l.chave);
      reg.acao.push(acao);
      reg.desc.push(desc);
      reg.valor.push(valor);
      reg.data.push(data);
    };

    for (const { l, d } of planos) {
      if (d.acao === "ignorar") {
        resumo.ignorados++;
        registrar(
          l,
          `ignorado: ${d.motivo}`,
          limparDescricao(l.tx.description),
          Math.abs(l.tx.amount),
          dataBrasil(l.tx.date)
        );
        continue;
      }

      if (d.acao === "guardar") {
        resumo.guardados++;
        registrar(l, `guardado: ${d.forma}`, d.descricao, d.valor, d.data);
        continue;
      }

      // Ja lancado a mao ou pelo Apple Pay: so liga um ao outro.
      const mesmo = acharMesmoGasto(d, soltos);
      if (mesmo) {
        soltos = soltos.filter((s) => s.id !== mesmo.id);
        await sql`
          update gastos
             set externo = ${l.chave}, fatura = coalesce(${faturaDe(l)}::int, fatura)
           where id = ${mesmo.id} and externo is null
        `;
        resumo.vinculados++;
        registrar(l, "já lançado", d.descricao, d.valor, d.data);
        continue;
      }

      ins.data.push(d.data);
      ins.desc.push(d.descricao);
      ins.cat.push(d.categoria);
      ins.pago.push(d.pagoCom);
      ins.valor.push(d.valor);
      ins.chave.push(l.chave);
      ins.fatura.push(faturaDe(l));
      resumo.novos++;
      registrar(l, `gasto: ${d.pagoCom}`, d.descricao, d.valor, d.data);
    }

    if (ins.chave.length > 0) {
      await sql`
        insert into gastos (data, descricao, categoria, pago_com, valor, origem, externo, fatura)
        select t.data::date, t.descricao, t.categoria, t.pago_com, t.valor, 'banco', t.chave, t.fatura
          from unnest(${ins.data}::text[], ${ins.desc}::text[], ${ins.cat}::text[],
                      ${ins.pago}::text[], ${ins.valor}::numeric[], ${ins.chave}::text[],
                      ${ins.fatura}::int[])
               as t(data, descricao, categoria, pago_com, valor, chave, fatura)
        on conflict do nothing
      `;
    }
    if (reg.chave.length > 0) {
      await sql`
        insert into importados (chave, acao, descricao, valor, data)
        select * from unnest(${reg.chave}::text[], ${reg.acao}::text[], ${reg.desc}::text[],
                             ${reg.valor}::numeric[], ${reg.data}::date[])
        on conflict (chave) do nothing
      `;
    }

    await guardarInvestimentos(investimentos, vistas, hojeIso);

    const falhas = resumo.bancos.filter((b) => b.status === "ERRO" || b.erro);
    if (falhas.length > 0 && falhas.length === resumo.bancos.length) {
      resumo.erro = falhas.map((b) => `${b.nome}: ${b.erro}`).join(" · ");
    }
  } catch (e) {
    resumo.erro = e instanceof Error ? e.message : String(e);
  }

  try {
    await gravar("bancos_resumo", JSON.stringify(resumo));
  } catch {
    // sem banco nao ha onde guardar; o resumo volta mesmo assim
  }
  return resumo;
}
