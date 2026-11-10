/**
 * Importacao automatica dos bancos: guarda as chaves do Meu Pluggy, puxa as
 * transacoes e transforma em gasto (ou em conta paga). Roda no cron diario e
 * no botao "Sincronizar agora".
 */
import { db, ensureSchema } from "./db";
import { abrirMes, listarContas } from "./data";
import { hoje } from "./format";
import {
  acharMesmoGasto,
  autenticar,
  buscarContas,
  buscarItem,
  buscarTransacoes,
  casarContaAberta,
  chaveDe,
  dataBrasil,
  decidir,
  limparDescricao,
  movimentosInternos,
  nomeDaConta,
  OPERACOES_TRANSFERENCIA,
  type ContaAberta,
  type Decisao,
  type GastoSolto,
  type Lida,
} from "./pluggy";

export const NAO_IMPORTAR = "__ignorar";

export type ContaDoBanco = { id: string; banco: string; nome: string; cartao: boolean };

export type ResumoBancos = {
  quando: string;
  novos: number;
  vinculados: number;
  contasPagas: number;
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
  const temSecret = Boolean(c.get("bancos_client_secret"));
  return {
    configurado: Boolean(clientId && temSecret && itens.length > 0),
    clientId,
    temSecret,
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
  if (dados.clientSecret) await gravar("bancos_client_secret", dados.clientSecret);
  await gravar("bancos_itens", [...new Set(dados.itens)].join(","));
  if (!c.get("bancos_desde")) {
    const { ano, mes } = hoje();
    await gravar("bancos_desde", `${ano}-${String(mes).padStart(2, "0")}-01`);
  }
}

export async function salvarMapa(mapa: Record<string, string>): Promise<void> {
  await ensureSchema();
  await gravar("bancos_mapa", JSON.stringify(mapa));
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

const idx = (data: string) => {
  const [a, m] = data.split("-").map(Number);
  return a * 12 + m;
};

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
    contasPagas: 0,
    ignorados: 0,
    bancos: [],
    erro: null,
  };

  try {
    const c = await lerTudo();
    const clientId = c.get("bancos_client_id");
    const secret = c.get("bancos_client_secret");
    const itens = (c.get("bancos_itens") ?? "").split(",").filter(Boolean);
    if (!clientId || !secret || itens.length === 0) {
      throw new Error("Bancos ainda não configurados.");
    }
    const mapa = json<Record<string, string>>(c.get("bancos_mapa"), {});
    const { iso: hojeIso } = hoje();
    const desde = c.get("bancos_desde") ?? hojeIso.slice(0, 8) + "01";
    const janela = [desde, menosDias(hojeIso, 45)].sort()[1];

    const apiKey = await autenticar(clientId, secret);

    const lidas: Lida[] = [];
    const vistas: ContaDoBanco[] = [];
    await Promise.all(
      itens.map(async (itemId) => {
        try {
          const item = await buscarItem(apiKey, itemId);
          const banco = item.connector?.name ?? "Banco";
          resumo.bancos.push({
            nome: banco,
            status: item.status,
            expira: item.consentExpiresAt ?? null,
            atualizado: item.lastUpdatedAt ?? null,
            erro: item.error?.message ?? item.error?.code ?? null,
          });
          const contas = await buscarContas(apiKey, itemId);
          await Promise.all(
            contas.map(async (conta) => {
              vistas.push({
                id: conta.id,
                banco,
                nome: nomeDaConta(conta),
                cartao: conta.type === "CREDIT",
              });
              const txs = await buscarTransacoes(apiKey, conta.id, janela);
              for (const tx of txs) lidas.push({ chave: chaveDe(tx), tx, conta });
            })
          );
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

    const unicas = new Map<string, Lida>();
    for (const l of lidas) if (!jaVistas.has(l.chave)) unicas.set(l.chave, l);
    const novas = [...unicas.values()].sort((a, b) =>
      a.tx.date < b.tx.date ? -1 : a.tx.date > b.tx.date ? 1 : 0
    );

    type Plano = { l: Lida; d: Decisao };
    const planos: Plano[] = [];
    for (const l of novas) {
      const data = dataBrasil(l.tx.date);
      const escolha = mapa[l.conta.id];
      let d: Decisao;
      if (escolha === NAO_IMPORTAR) {
        d = { acao: "ignorar", motivo: "conta marcada para não importar" };
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
          escolha && nomesCartoes.includes(escolha) ? escolha : null
        );
      }
      // Saida agendada volta a ser olhada quando acontecer.
      if (d.acao === "ignorar" && d.motivo === "agendado") continue;
      planos.push({ l, d });
    }

    const gastos = planos.filter(
      (p): p is { l: Lida; d: Extract<Decisao, { acao: "gasto" }> } => p.d.acao === "gasto"
    );

    let abertas: ContaAberta[] = [];
    let soltos: GastoSolto[] = [];
    if (gastos.length > 0) {
      const datas = gastos.map((g) => g.d.data).sort();
      const min = idx(datas[0]);
      const max = idx(datas[datas.length - 1]);
      for (let i = min; i <= max; i++) {
        await abrirMes(Math.floor((i - 1) / 12), ((i - 1) % 12) + 1);
      }
      abertas = ((await sql`
        select m.id, m.ano, m.mes, m.previsto, c.nome
          from contas_mes m
          join contas c on c.id = m.conta_id
         where not m.pago and c.ativo and c.tipo = 'fixa'
           and m.ano * 12 + m.mes between ${min} and ${max}
      `) as Array<Record<string, unknown>>).map((r) => ({
        id: Number(r.id),
        ano: Number(r.ano),
        mes: Number(r.mes),
        previsto: Number(r.previsto),
        nome: String(r.nome),
      }));
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
    const ins = { data: [] as string[], desc: [] as string[], cat: [] as string[], pago: [] as string[], valor: [] as number[], chave: [] as string[] };
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

      // Boleto ou debito do valor de uma conta fixa em aberto: a conta e paga.
      if (!d.cartao) {
        const conta = casarContaAberta(d.valor, d.data, abertas);
        if (conta) {
          abertas = abertas.filter((a) => a.id !== conta.id);
          await sql`
            update contas_mes
               set pago = true, valor_pago = ${d.valor}, data_pgto = ${d.data}
             where id = ${conta.id} and not pago
          `;
          resumo.contasPagas++;
          registrar(l, `conta paga: ${conta.nome}`, d.descricao, d.valor, d.data);
          continue;
        }
      }

      // Ja lancado a mao ou pelo Apple Pay: so liga um ao outro.
      const mesmo = acharMesmoGasto(d, soltos);
      if (mesmo) {
        soltos = soltos.filter((s) => s.id !== mesmo.id);
        await sql`update gastos set externo = ${l.chave} where id = ${mesmo.id} and externo is null`;
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
      resumo.novos++;
      registrar(l, `gasto: ${d.pagoCom}`, d.descricao, d.valor, d.data);
    }

    if (ins.chave.length > 0) {
      await sql`
        insert into gastos (data, descricao, categoria, pago_com, valor, origem, externo)
        select t.data::date, t.descricao, t.categoria, t.pago_com, t.valor, 'banco', t.chave
          from unnest(${ins.data}::text[], ${ins.desc}::text[], ${ins.cat}::text[],
                      ${ins.pago}::text[], ${ins.valor}::numeric[], ${ins.chave}::text[])
               as t(data, descricao, categoria, pago_com, valor, chave)
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
