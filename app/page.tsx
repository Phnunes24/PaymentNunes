import { redirect } from "next/navigation";
import { estaLogado } from "@/lib/auth";
import {
  contasDoMes,
  gastosDoMes,
  listarContas,
  ciclosDosCartoes,
  faturaDoGasto,
  type Ciclo,
  porCategoria,
  porSecao,
  rendaDoMes,
  CATEGORIAS,
  FORMAS_EXTRA,
  type LinhaMes,
} from "@/lib/data";
import {
  hoje,
  hojePorExtenso,
  nomeMes,
  moeda,
  rotuloMes,
  deslocaMes,
  dataBR,
  parseInteiro,
} from "@/lib/format";
import {
  pagarConta,
  desfazerPagamento,
  novoGasto,
  excluirGasto,
  salvarConta,
  salvarPrevisto,
  salvarGasto,
  salvarRenda,
  novaConta,
  apagarContaAction,
  salvarBancosAction,
  sincronizarAgoraAction,
  salvarCartoesBancoAction,
  desconectarBancosAction,
  sairAction,
} from "./actions";
import {
  lerConfigBancos,
  ultimosImportados,
  NAO_IMPORTAR,
  type ConfigBancos,
  type Importado,
} from "@/lib/bancos";
import { mesDoIndice } from "@/lib/resumo";
import MesDoDispositivo from "./mes-do-dispositivo";

export const dynamic = "force-dynamic";
// A sincronizacao com os bancos roda dentro das acoes desta pagina e pode
// levar alguns segundos.
export const maxDuration = 60;

const ORIGEM: Record<string, string> = {
  banco: "banco",
  "apple-pay": "Apple Pay",
};

/** "2026-11-10T13:05:00Z" -> "10/11 10:05", no horario de Brasilia. */
function quandoBR(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

const SELO: Record<LinhaMes["status"], string> = {
  pago: "Pago",
  atrasado: "Atrasado",
  aberto: "Em aberto",
};

const CLASSE_CONTA: Record<LinhaMes["status"], string> = {
  pago: "conta conta-paga",
  atrasado: "conta conta-atrasada",
  aberto: "conta",
};

const ERROS: Record<string, string> = {
  gasto: "Para lançar um gasto preencha a descrição e um valor maior que zero.",
  conta: "Para criar uma conta preencha pelo menos o nome.",
  conta_existe: "Já existe uma conta com esse nome.",
  bancos: "Para conectar os bancos cole o Client ID e pelo menos um ID de item.",
};

/** Valor em formato de digitacao: 1326.74 -> "1326,74". */
function campo(valor: number): string {
  return valor.toFixed(2).replace(".", ",");
}

export default async function Painel({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string; mes?: string; erro?: string }>;
}) {
  if (!(await estaLogado())) redirect("/login");

  const sp = await searchParams;
  const agora = hoje();
  const mesExplicito = Boolean(sp.ano && sp.mes);
  const ano = parseInteiro(sp.ano ?? null, agora.ano) ?? agora.ano;
  const mesBruto = parseInteiro(sp.mes ?? null, agora.mes) ?? agora.mes;
  const mes = mesBruto >= 1 && mesBruto <= 12 ? mesBruto : agora.mes;

  const anterior = deslocaMes(ano, mes, -1);
  const proximo = deslocaMes(ano, mes, 1);

  let linhas: LinhaMes[] = [];
  let gastos: Awaited<ReturnType<typeof gastosDoMes>> = [];
  let contas: Awaited<ReturnType<typeof listarContas>> = [];
  let renda = 0;
  let bancos: ConfigBancos | null = null;
  let importados: Importado[] = [];
  let ciclos = new Map<string, Ciclo>();
  let falhaBanco: string | null = null;

  try {
    [linhas, gastos, contas, renda, bancos, importados, ciclos] = await Promise.all([
      contasDoMes(ano, mes),
      gastosDoMes(ano, mes),
      listarContas(),
      rendaDoMes(ano, mes),
      lerConfigBancos(),
      ultimosImportados(15),
      ciclosDosCartoes(),
    ]);
  } catch (e) {
    falhaBanco = e instanceof Error ? e.message : String(e);
  }

  const previsto = linhas.reduce((s, l) => s + l.previsto, 0);
  const pago = linhas.reduce((s, l) => s + l.pagoEfetivo, 0);
  const falta = previsto - pago;
  const pct = previsto > 0 ? pago / previsto : 0;
  const totalGastos = gastos.reduce((s, g) => s + g.valor, 0);
  const emAberto = linhas.filter((l) => l.status !== "pago").length;
  const categorias = porCategoria(gastos);
  const secoes = porSecao(linhas);
  const cartoes = contas.filter((c) => c.tipo === "cartao");
  const formas = [...cartoes.map((c) => c.nome), ...FORMAS_EXTRA];
  const contaPorId = new Map(contas.map((c) => [c.id, c]));
  // Gasto no cartao ja esta dentro do previsto, virou fatura. So o que saiu
  // por fora entra de novo na conta da sobra, senao contaria duas vezes. Um
  // cartao ja apagado que aparece no mes, porque foi pago, tambem conta.
  const nomesCartoes = new Set([
    ...cartoes.map((c) => c.nome),
    ...linhas.filter((l) => l.tipo === "cartao").map((l) => l.nome),
  ]);
  const gastosAvulsos = gastos
    .filter((g) => !nomesCartoes.has(g.pago_com))
    .reduce((s, g) => s + g.valor, 0);
  const sobra = renda - previsto - gastosAvulsos;
  const nomesSecoes = [...new Set(contas.map((c) => c.secao))];
  const ehMesAtual = ano === agora.ano && mes === agora.mes;
  // Olhando outro mes, o gasto novo nasce no dia 1 dele, e nao em hoje:
  // um lancamento datado de outro mes desapareceria da tela.
  const dataPadrao = ehMesAtual
    ? agora.iso
    : `${ano}-${String(mes).padStart(2, "0")}-01`;

  return (
    <>
      <header className="topo">
        <div className="topo-interno">
          <h1>Minhas contas</h1>
          <a className="sair" href="/investimentos">
            Investimentos
          </a>
          <form action={sairAction}>
            <button className="sair" type="submit">
              Sair
            </button>
          </form>
          <div className="nav-mes">
            <a
              href={`/?ano=${anterior.ano}&mes=${anterior.mes}`}
              aria-label="Mês anterior"
            >
              ‹
            </a>
            <strong>{rotuloMes(ano, mes)}</strong>
            <a
              href={`/?ano=${proximo.ano}&mes=${proximo.mes}`}
              aria-label="Próximo mês"
            >
              ›
            </a>
          </div>
        </div>
      </header>

      <main className="pagina">
        <MesDoDispositivo ano={ano} mes={mes} explicito={mesExplicito} />

        {falhaBanco ? (
          <div className="aviso">
            <strong>Banco de dados ainda não conectado.</strong>
            <br />
            No painel do Vercel abra Storage, crie um banco Postgres e conecte
            ao projeto. A variável <code>DATABASE_URL</code> aparece sozinha e
            as tabelas se criam no primeiro acesso.
            <br />
            <small>{falhaBanco}</small>
          </div>
        ) : null}

        {sp.erro && ERROS[sp.erro] ? (
          <div className="erro">{ERROS[sp.erro]}</div>
        ) : null}

        {ehMesAtual ? (
          <p className="hoje">Hoje é {hojePorExtenso()}</p>
        ) : null}

        {!ehMesAtual ? (
          <div className="aviso">
            Você está vendo {rotuloMes(ano, mes)}.{" "}
            <a href="/">Voltar para {rotuloMes(agora.ano, agora.mes)}</a>
          </div>
        ) : null}

        <div className="cartoes">
          <div className={`cartao ${sobra < 0 ? "cartao-alerta" : "cartao-bom"}`}>
            <span>{sobra < 0 ? "Estourou o mês" : "Sobra no mês"}</span>
            <strong>{moeda(sobra)}</strong>
            <div className="sub">renda menos contas e gastos fora do cartão</div>
          </div>
          <div className="cartao cartao-renda">
            <span>Renda do mês</span>
            <form action={salvarRenda} className="campo-input">
              <input type="hidden" name="ano" value={ano} />
              <input type="hidden" name="mes" value={mes} />
              <input
                name="renda"
                inputMode="decimal"
                defaultValue={campo(renda)}
                aria-label={`Renda de ${rotuloMes(ano, mes)}`}
              />
              <button
                className="btn-leve"
                type="submit"
                aria-label="Salvar renda do mês"
              >
                ✓
              </button>
            </form>
          </div>
          <div className="cartao">
            <span>Previsto</span>
            <strong>{moeda(previsto)}</strong>
          </div>
          <div className="cartao">
            <span>Já pago</span>
            <strong>{moeda(pago)}</strong>
          </div>
          <div className="cartao">
            <span>Falta pagar</span>
            <strong>{moeda(falta)}</strong>
          </div>
          <div className="cartao">
            <span>{pct >= 1 ? "Tudo pago" : "Em aberto"}</span>
            <strong>
              {emAberto === 0 ? "✓" : emAberto}
              {emAberto > 0 ? (
                <small style={{ fontSize: 14, fontWeight: 500 }}>
                  {" "}
                  de {linhas.length}
                </small>
              ) : null}
            </strong>
          </div>
        </div>

        <section>
          <h2>Contas do mês</h2>
          <datalist id="secoes">
            {nomesSecoes.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>

          {secoes.map(([secao, itens]) => {
            const somaSecao = itens.reduce((s, l) => s + l.previsto, 0);
            return (
              <div className="grupo" key={secao}>
                <div className="grupo-cab">
                  <span>{secao}</span>
                  <span className="num">{moeda(somaSecao)}</span>
                </div>
                {itens.map((l) => (
                  <article className={CLASSE_CONTA[l.status]} key={l.conta_id}>
                    <div className="conta-cab">
                      <div>
                        <span className="conta-nome">{l.nome}</span>
                        {l.tipo === "cartao" ? (
                          <span className="sub">
                            {l.previstoManual
                              ? "valor digitado"
                              : "soma das compras desta fatura"}
                          </span>
                        ) : l.vencimento ? (
                          <span className="sub">
                            vence {dataBR(l.vencimento)}
                          </span>
                        ) : null}
                      </div>
                      <span className={`selo selo-${l.status}`}>
                        {SELO[l.status]}
                      </span>
                    </div>

                    <div className="conta-acao">
                      <form action={salvarPrevisto} className="campo">
                        <label htmlFor={`prev-${l.conta_id}`}>Previsto</label>
                        <div className="campo-input">
                          <input type="hidden" name="ano" value={ano} />
                          <input type="hidden" name="mes" value={mes} />
                          <input
                            type="hidden"
                            name="conta_id"
                            value={l.conta_id}
                          />
                          <input
                            id={`prev-${l.conta_id}`}
                            name="previsto"
                            inputMode="decimal"
                            defaultValue={campo(l.previsto)}
                          />
                          <button
                            className="btn-leve"
                            type="submit"
                            aria-label={`Salvar valor de ${l.nome}`}
                          >
                            ✓
                          </button>
                        </div>
                      </form>

                      {l.pago ? (
                        <form action={desfazerPagamento}>
                          <input type="hidden" name="ano" value={ano} />
                          <input type="hidden" name="mes" value={mes} />
                          <input
                            type="hidden"
                            name="conta_id"
                            value={l.conta_id}
                          />
                          <button className="btn-leve" type="submit">
                            Desfazer
                          </button>
                        </form>
                      ) : (
                        <form action={pagarConta} className="campo">
                          <label htmlFor={`pago-${l.conta_id}`}>
                            Valor pago
                          </label>
                          <div className="campo-input">
                            <input type="hidden" name="ano" value={ano} />
                            <input type="hidden" name="mes" value={mes} />
                            <input
                              type="hidden"
                              name="conta_id"
                              value={l.conta_id}
                            />
                            <input
                              id={`pago-${l.conta_id}`}
                              name="valor_pago"
                              inputMode="decimal"
                              placeholder={campo(l.previsto)}
                            />
                            <button className="btn" type="submit">
                              Pagar
                            </button>
                          </div>
                        </form>
                      )}
                    </div>

                    {l.pago && l.data_pgto ? (
                      <div className="sub conta-pago">
                        Pago {moeda(l.pagoEfetivo)} em {dataBR(l.data_pgto)}
                      </div>
                    ) : null}

                    {(() => {
                      const c = contaPorId.get(l.conta_id);
                      if (!c) {
                        return (
                          <div className="sub conta-pago">
                            Conta apagada. Aparece aqui só porque foi paga
                            neste mês.
                          </div>
                        );
                      }
                      return (
                        <details className="editar">
                          <summary>Editar conta</summary>
                          <form action={salvarConta} className="editar-grade">
                            <input type="hidden" name="ano" value={ano} />
                            <input type="hidden" name="mes" value={mes} />
                            <input type="hidden" name="id" value={c.id} />
                            <div className="campo editar-largo">
                              <label htmlFor={`nome-${c.id}`}>Nome</label>
                              <input
                                id={`nome-${c.id}`}
                                name="nome"
                                defaultValue={c.nome}
                                maxLength={60}
                                required
                              />
                            </div>
                            <div className="campo">
                              <label htmlFor={`sec-${c.id}`}>Seção</label>
                              <input
                                id={`sec-${c.id}`}
                                name="secao"
                                defaultValue={c.secao}
                                list="secoes"
                                maxLength={40}
                              />
                            </div>
                            <div className="campo">
                              <label htmlFor={`tipo-${c.id}`}>Tipo</label>
                              <select
                                id={`tipo-${c.id}`}
                                name="tipo"
                                defaultValue={c.tipo}
                              >
                                <option value="fixa">Valor fixo</option>
                                <option value="cartao">Cartão</option>
                              </select>
                            </div>
                            <div className="campo">
                              <label htmlFor={`val-${c.id}`}>Valor mensal</label>
                              <input
                                id={`val-${c.id}`}
                                name="valor"
                                inputMode="decimal"
                                defaultValue={
                                  c.tipo === "cartao" ? "" : campo(c.valor)
                                }
                                placeholder={
                                  c.tipo === "cartao" ? "soma dos gastos" : "0,00"
                                }
                              />
                            </div>
                            <div className="campo">
                              <label htmlFor={`dia-${c.id}`}>Dia venc.</label>
                              <input
                                id={`dia-${c.id}`}
                                name="dia_vencimento"
                                inputMode="numeric"
                                defaultValue={c.dia_vencimento ?? ""}
                                placeholder="dia"
                              />
                            </div>
                            {c.tipo === "cartao" ? (
                              <div className="campo">
                                <label htmlFor={`fecha-${c.id}`}>Fecha dia</label>
                                <input
                                  id={`fecha-${c.id}`}
                                  name="dia_fechamento"
                                  inputMode="numeric"
                                  defaultValue={c.dia_fechamento ?? ""}
                                  placeholder="dia"
                                />
                              </div>
                            ) : null}
                            <button className="btn editar-largo" type="submit">
                              Salvar alterações
                            </button>
                          </form>
                          <p className="sub editar-nota">
                            O valor novo vale deste mês em diante, nos meses
                            ainda não pagos. Mês em que você digitou um
                            previsto só dele continua como está.
                          </p>
                          <details className="apagar">
                            <summary>Apagar conta</summary>
                            <p className="sub">
                              Ela some deste mês em diante. Os meses anteriores
                              em que você pagou continuam no histórico.
                            </p>
                            <form action={apagarContaAction}>
                              <input type="hidden" name="ano" value={ano} />
                              <input type="hidden" name="mes" value={mes} />
                              <input type="hidden" name="id" value={c.id} />
                              <button className="btn-perigo" type="submit">
                                Apagar {c.nome}
                              </button>
                            </form>
                          </details>
                        </details>
                      );
                    })()}
                  </article>
                ))}
              </div>
            );
          })}

          {linhas.length === 0 ? (
            <p className="vazio">Nenhuma conta cadastrada ainda.</p>
          ) : null}

          <p className="vazio">
            Todo valor é editável: digite por cima e toque no ✓. Campo vazio
            volta ao automático, o do cadastro nas contas fixas e a soma das
            compras da fatura nos cartões. Nome, seção, tipo e vencimento ficam em Editar
            conta, no próprio card, junto com o botão de apagar.
          </p>

          <details className="criar">
            <summary>Adicionar conta</summary>
            <form action={novaConta} className="linha-form form-conta">
              <input type="hidden" name="ano" value={ano} />
              <input type="hidden" name="mes" value={mes} />
              <input name="nome" placeholder="Nome da conta" required />
              <input
                name="secao"
                placeholder="Seção (ex.: Comida)"
                list="secoes"
                aria-label="Seção"
              />
              <select name="tipo" defaultValue="fixa" aria-label="Tipo">
                <option value="fixa">Valor fixo</option>
                <option value="cartao">Cartão (soma dos gastos)</option>
              </select>
              <input
                name="valor"
                inputMode="decimal"
                placeholder="Valor mensal"
                aria-label="Valor mensal"
              />
              <input
                name="dia_vencimento"
                inputMode="numeric"
                placeholder="Dia do vencimento"
                aria-label="Dia do vencimento"
              />
              <button className="btn" type="submit">
                Criar conta
              </button>
            </form>
            <p className="vazio">
              Escolhendo Cartão, a conta não tem valor próprio: ela soma os
              gastos que você marcar como pagos com ela, e o nome aparece na
              lista de Pago com.
            </p>
          </details>
        </section>

        <section>
          <h2>Lançar gasto</h2>
          <form action={novoGasto} className="linha-form form-gasto">
            <input type="hidden" name="ano" value={ano} />
            <input type="hidden" name="mes" value={mes} />
            <input
              type="date"
              name="data"
              defaultValue={dataPadrao}
              aria-label="Data"
            />
            <input
              name="descricao"
              placeholder="Descrição"
              aria-label="Descrição"
              required
            />
            <select name="categoria" defaultValue="Mercado" aria-label="Categoria">
              {CATEGORIAS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select name="pago_com" aria-label="Pago com">
              {formas.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <input
              name="valor"
              inputMode="decimal"
              placeholder="Valor 0,00"
              aria-label="Valor"
              required
            />
            <button className="btn" type="submit">
              Lançar
            </button>
          </form>

          {gastos.map((g) => (
            <div className="gasto" key={g.id}>
              <strong className="gasto-desc">{g.descricao}</strong>
              <form action={salvarGasto} className="campo-mini gasto-valor">
                <input type="hidden" name="ano" value={ano} />
                <input type="hidden" name="mes" value={mes} />
                <input type="hidden" name="id" value={g.id} />
                <input type="hidden" name="descricao" value={g.descricao} />
                <input type="hidden" name="data" value={g.data} />
                <input type="hidden" name="categoria" value={g.categoria} />
                <input type="hidden" name="pago_com" value={g.pago_com} />
                <input
                  name="valor"
                  inputMode="decimal"
                  defaultValue={campo(g.valor)}
                  aria-label={`Valor de ${g.descricao}`}
                />
                <button
                  className="btn-leve"
                  type="submit"
                  aria-label={`Salvar valor de ${g.descricao}`}
                >
                  ✓
                </button>
              </form>
              <span className="sub gasto-meta">
                <span className="pill-cat">{g.categoria}</span>
                {ORIGEM[g.origem] ? (
                  <span className="pill-origem">{ORIGEM[g.origem]}</span>
                ) : null}
                {dataBR(g.data)} · {g.pago_com}
                {(() => {
                  // Compra no cartao que cai na fatura de outro mes.
                  const indice = faturaDoGasto(g, ciclos);
                  if (indice == null || indice === ano * 12 + mes) return null;
                  return ` · fatura de ${nomeMes(mesDoIndice(indice).mes)}`;
                })()}
              </span>
              <form action={excluirGasto} className="gasto-del">
                <input type="hidden" name="ano" value={ano} />
                <input type="hidden" name="mes" value={mes} />
                <input type="hidden" name="id" value={g.id} />
                <button
                  className="btn-x"
                  type="submit"
                  aria-label={`Excluir ${g.descricao}`}
                >
                  ×
                </button>
              </form>
            </div>
          ))}

          {gastos.length === 0 ? (
            <p className="vazio">Nenhum gasto lançado neste mês.</p>
          ) : (
            <p className="vazio">
              Total lançado no mês: <strong>{moeda(totalGastos)}</strong>
            </p>
          )}
        </section>

        {bancos ? (
          <section>
            <h2>Bancos</h2>
            {bancos.configurado ? (
              <>
                {bancos.resumo ? (
                  <div className="banco-resumo">
                    <span className="sub">
                      Última sincronização {quandoBR(bancos.resumo.quando)}
                    </span>
                    <div className="banco-numeros">
                      <span>
                        <strong>{bancos.resumo.novos}</strong> gastos novos
                      </span>
                      <span>
                        <strong>{bancos.resumo.guardados ?? 0}</strong> Pix e
                        boletos guardados
                      </span>
                      <span>
                        <strong>{bancos.resumo.vinculados}</strong> já lançados
                      </span>
                      <span>
                        <strong>{bancos.resumo.ignorados}</strong> ignorados
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="vazio">Ainda não sincronizou.</p>
                )}

                {bancos.resumo?.erro ? (
                  <div className="erro">{bancos.resumo.erro}</div>
                ) : null}

                {bancos.resumo && bancos.resumo.bancos.length > 0 ? (
                  <div className="banco-lista">
                    {bancos.resumo.bancos.map((b, i) => (
                      <div className="banco-item" key={`${b.nome}-${i}`}>
                        <strong>{b.nome}</strong>
                        <span className="sub">
                          {b.erro
                            ? b.erro
                            : b.expira
                              ? `autorizado até ${dataBR(b.expira.slice(0, 10))}`
                              : b.status}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

                <form action={sincronizarAgoraAction} className="banco-sync">
                  <input type="hidden" name="ano" value={ano} />
                  <input type="hidden" name="mes" value={mes} />
                  <button className="btn" type="submit">
                    Sincronizar agora
                  </button>
                </form>
                <p className="vazio">
                  Sincroniza sozinho todo dia de manhã. Os bancos mandam as
                  novidades uma vez por dia, então a compra de hoje aparece
                  amanhã; a do Apple Pay continua entrando na hora. Compras no
                  cartão e no débito entram sozinhas. Pix, transferências e
                  boletos ficam guardados na lista abaixo, sem entrar na conta,
                  porque podem ser o pagamento de uma conta do mês.
                </p>

                {bancos.contas.length > 0 ? (
                  <details className="criar">
                    <summary>Cartões e contas do banco</summary>
                    <form action={salvarCartoesBancoAction} className="mapa-form">
                      <input type="hidden" name="ano" value={ano} />
                      <input type="hidden" name="mes" value={mes} />
                      {bancos.contas.map((c) => (
                        <div className="campo" key={c.id}>
                          <label htmlFor={`mapa-${c.id}`}>
                            {c.banco} · {c.nome}
                          </label>
                          <select
                            id={`mapa-${c.id}`}
                            name={`mapa_${c.id}`}
                            defaultValue={bancos!.mapa[c.id] ?? ""}
                          >
                            <option value="">
                              {c.cartao ? "Escolher sozinho" : "Importar"}
                            </option>
                            {c.cartao
                              ? cartoes.map((k) => (
                                  <option key={k.id} value={k.nome}>
                                    Lançar em {k.nome}
                                  </option>
                                ))
                              : null}
                            <option value={NAO_IMPORTAR}>Não importar</option>
                          </select>
                        </div>
                      ))}
                      <button className="btn-leve" type="submit">
                        Salvar
                      </button>
                    </form>
                    <p className="vazio">
                      Diga em qual cartão daqui cai cada cartão do banco. Vale
                      para as próximas compras.
                    </p>
                  </details>
                ) : null}

                {importados.length > 0 ? (
                  <details className="criar">
                    <summary>O que entrou por último</summary>
                    <div className="cat-lista">
                      {importados.map((t, i) => (
                        <div className="importado" key={i}>
                          <span className="importado-desc">
                            {t.descricao}
                            <span className="sub"> · {dataBR(t.data)}</span>
                          </span>
                          <span className="num">{moeda(t.valor)}</span>
                          <span
                            className={
                              t.acao.startsWith("ignorado")
                                ? "sub importado-acao"
                                : "importado-acao"
                            }
                          >
                            {t.acao}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}

                <details className="criar">
                  <summary>Trocar chaves ou desconectar</summary>
                  <FormBancos
                    ano={ano}
                    mes={mes}
                    clientId={bancos.clientId}
                    itens={bancos.itens}
                    temSecret={bancos.temSecret}
                  />
                  <form action={desconectarBancosAction}>
                    <input type="hidden" name="ano" value={ano} />
                    <input type="hidden" name="mes" value={mes} />
                    <button className="btn-perigo" type="submit">
                      Desconectar bancos
                    </button>
                  </form>
                </details>
              </>
            ) : (
              <>
                {bancos.secretIlegivel ? (
                  <div className="erro">
                    O Client Secret guardado não abre mais, provavelmente
                    porque a senha do app mudou. Cole o Client Secret de novo
                    aqui embaixo; o resto continua salvo.
                  </div>
                ) : null}
                <p className="vazio">
                  Puxe sozinho os gastos do cartão e da conta pelo Open
                  Finance, de graça, com o Meu Pluggy (uso pessoal, até 5
                  bancos).
                </p>
                <ol className="passos">
                  <li>
                    Crie sua conta em{" "}
                    <a href="https://meu.pluggy.ai" target="_blank" rel="noreferrer">
                      meu.pluggy.ai
                    </a>{" "}
                    e conecte o Nubank e o Bradesco. Cada banco pede a
                    autorização no app dele.
                  </li>
                  <li>
                    Entre em{" "}
                    <a href="https://dashboard.pluggy.ai" target="_blank" rel="noreferrer">
                      dashboard.pluggy.ai
                    </a>{" "}
                    com a mesma conta. Em Applications, abra a sua aplicação,
                    vá em Demo, toque em Connect Account e escolha{" "}
                    <strong>MeuPluggy</strong> (não o banco). Repita para cada
                    banco.
                  </li>
                  <li>
                    Copie o Client ID, gere o Client Secret e copie o ID de
                    cada item em Connected Items. Cole aqui embaixo.
                  </li>
                </ol>
                <FormBancos
                  ano={ano}
                  mes={mes}
                  clientId={bancos.clientId}
                  itens={bancos.itens}
                  temSecret={bancos.temSecret}
                />
              </>
            )}
          </section>
        ) : null}

        {categorias.length > 0 ? (
          <section>
            <h2>Gastos por categoria</h2>
            <div className="cat-lista">
              {categorias.map(([nome, valor]) => (
                <div className="cat-item" key={nome}>
                  <span>{nome}</span>
                  <span className="num">{moeda(valor)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <p className="rodape">
          A renda vale deste mês em diante até você digitar outra. O mês
          seguinte abre sozinho no dia 1. A fatura de cada cartão é a soma das
          compras que caem nela: com o dia de fechamento cadastrado, a compra
          vai para a fatura do mês em que você paga, e não do mês em que
          comprou.
        </p>
      </main>
    </>
  );
}

/** Formulario das chaves do Meu Pluggy. O secret nunca volta para a tela. */
function FormBancos({
  ano,
  mes,
  clientId,
  itens,
  temSecret,
}: {
  ano: number;
  mes: number;
  clientId: string;
  itens: string[];
  temSecret: boolean;
}) {
  return (
    <form action={salvarBancosAction} className="linha-form">
      <input type="hidden" name="ano" value={ano} />
      <input type="hidden" name="mes" value={mes} />
      <div className="campo">
        <label htmlFor="client-id">Client ID</label>
        <input
          id="client-id"
          name="client_id"
          defaultValue={clientId}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
        />
      </div>
      <div className="campo">
        <label htmlFor="client-secret">Client Secret</label>
        <input
          id="client-secret"
          name="client_secret"
          type="password"
          autoComplete="off"
          placeholder={temSecret ? "salvo; deixe vazio para manter" : ""}
          required={!temSecret}
        />
      </div>
      <div className="campo">
        <label htmlFor="itens">IDs dos itens (um por linha)</label>
        <textarea
          id="itens"
          name="itens"
          rows={3}
          defaultValue={itens.join("\n")}
          autoCapitalize="off"
          spellCheck={false}
          required
        />
      </div>
      <button className="btn" type="submit">
        Salvar e sincronizar
      </button>
    </form>
  );
}
