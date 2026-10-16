import { redirect } from "next/navigation";
import { estaLogado } from "@/lib/auth";
import {
  contasDoMes,
  gastosDoMes,
  listarContas,
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
  removerConta,
  sairAction,
} from "./actions";
import MesDoDispositivo from "./mes-do-dispositivo";

export const dynamic = "force-dynamic";

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
  let falhaBanco: string | null = null;

  try {
    [linhas, gastos, contas, renda] = await Promise.all([
      contasDoMes(ano, mes),
      gastosDoMes(ano, mes),
      listarContas(),
      rendaDoMes(ano, mes),
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
  // Gasto no cartao ja esta dentro do previsto, virou fatura. So o que saiu
  // por fora entra de novo na conta da sobra, senao contaria duas vezes.
  const nomesCartoes = new Set(cartoes.map((c) => c.nome));
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
                              : "soma dos gastos do mês"}
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
            volta ao automático, o do cadastro nas contas fixas e a soma dos
            gastos nos cartões.
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
              <datalist id="secoes">
                {nomesSecoes.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
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
                {dataBR(g.data)} · {g.pago_com}
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

        <section>
          <details>
            <summary>Ajustes das contas</summary>
            {contas.map((c) => (
              <div className="ajuste" key={c.id}>
                <div className="ajuste-cab">
                  <strong>{c.nome}</strong>
                  <span className="sub">
                    {c.tipo === "cartao" ? "cartão" : "valor fixo"}
                  </span>
                </div>
                <form action={salvarConta} className="ajuste-grade">
                  <input type="hidden" name="ano" value={ano} />
                  <input type="hidden" name="mes" value={mes} />
                  <input type="hidden" name="id" value={c.id} />
                  <div className="campo">
                    <label htmlFor={`sec-${c.id}`}>Seção</label>
                    <input
                      id={`sec-${c.id}`}
                      name="secao"
                      defaultValue={c.secao}
                      list="secoes"
                    />
                  </div>
                  <div className="campo">
                    <label htmlFor={`val-${c.id}`}>Valor</label>
                    <input
                      id={`val-${c.id}`}
                      name="valor"
                      inputMode="decimal"
                      defaultValue={c.tipo === "cartao" ? "" : campo(c.valor)}
                      placeholder={c.tipo === "cartao" ? "vem dos gastos" : "0,00"}
                      disabled={c.tipo === "cartao"}
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
                  <button className="btn-leve" type="submit">
                    Salvar
                  </button>
                </form>
                <form action={removerConta} className="ajuste-rem">
                  <input type="hidden" name="ano" value={ano} />
                  <input type="hidden" name="mes" value={mes} />
                  <input type="hidden" name="id" value={c.id} />
                  <button className="btn-x" type="submit" aria-label={`Remover ${c.nome}`}>
                    Remover conta
                  </button>
                </form>
              </div>
            ))}
            <p className="vazio">
              O valor novo vale deste mês em diante, e só nas contas que ainda
              não foram marcadas como pagas. Remover tira a conta dos próximos
              meses e mantém o que já foi pago.
            </p>
          </details>
        </section>

        <p className="rodape">
          A renda vale deste mês em diante até você digitar outra. O mês
          seguinte abre sozinho no dia 1. As faturas dos cartões são a soma do
          que você lançou em Gastos.
        </p>
      </main>
    </>
  );
}
