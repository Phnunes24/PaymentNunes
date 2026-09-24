import { redirect } from "next/navigation";
import { estaLogado } from "@/lib/auth";
import {
  contasDoMes,
  gastosDoMes,
  listarContas,
  porCategoria,
  CATEGORIAS,
  FORMAS_EXTRA,
  type LinhaMes,
} from "@/lib/data";
import {
  hoje,
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
  sairAction,
} from "./actions";

export const dynamic = "force-dynamic";

const SELO: Record<LinhaMes["status"], string> = {
  pago: "Pago",
  atrasado: "Atrasado",
  aberto: "Em aberto",
};

export default async function Painel({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string; mes?: string; erro?: string }>;
}) {
  if (!(await estaLogado())) redirect("/login");

  const sp = await searchParams;
  const agora = hoje();
  const ano = parseInteiro(sp.ano ?? null, agora.ano) ?? agora.ano;
  const mesBruto = parseInteiro(sp.mes ?? null, agora.mes) ?? agora.mes;
  const mes = mesBruto >= 1 && mesBruto <= 12 ? mesBruto : agora.mes;

  const anterior = deslocaMes(ano, mes, -1);
  const proximo = deslocaMes(ano, mes, 1);

  let linhas: LinhaMes[] = [];
  let gastos: Awaited<ReturnType<typeof gastosDoMes>> = [];
  let contas: Awaited<ReturnType<typeof listarContas>> = [];
  let falhaBanco: string | null = null;

  try {
    [linhas, gastos, contas] = await Promise.all([
      contasDoMes(ano, mes),
      gastosDoMes(ano, mes),
      listarContas(),
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
  const cartoes = contas.filter((c) => c.tipo === "cartao");
  const formas = [...cartoes.map((c) => c.nome), ...FORMAS_EXTRA];
  const ehMesAtual = ano === agora.ano && mes === agora.mes;

  return (
    <>
      <header className="topo">
        <div className="topo-interno">
          <h1>Minhas contas</h1>
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
          <form action={sairAction}>
            <button className="sair" type="submit">
              Sair
            </button>
          </form>
        </div>
      </header>

      <main className="pagina">
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

        {sp.erro === "gasto" ? (
          <div className="erro">
            Para lançar um gasto preencha a descrição e um valor maior que zero.
          </div>
        ) : null}

        {!ehMesAtual ? (
          <div className="aviso">
            Você está vendo {rotuloMes(ano, mes)}.{" "}
            <a href="/">Voltar para {rotuloMes(agora.ano, agora.mes)}</a>
          </div>
        ) : null}

        <div className="cartoes">
          <div className="cartao">
            <span>Previsto no mês</span>
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
            <span>{pct >= 1 ? "Tudo pago" : "Contas em aberto"}</span>
            <strong>
              {emAberto === 0 ? "✓" : emAberto}
              {emAberto > 0 ? (
                <small style={{ fontSize: 13, fontWeight: 400 }}>
                  {" "}
                  de {linhas.length}
                </small>
              ) : null}
            </strong>
          </div>
        </div>

        <section>
          <h2>Contas do mês</h2>
          <table>
            <thead>
              <tr>
                <th>Conta</th>
                <th className="esconde-mobile">Vencimento</th>
                <th className="num">Previsto</th>
                <th>Status</th>
                <th className="num">Ação</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.conta_id}>
                  <td>
                    <strong>{l.nome}</strong>
                    {l.tipo === "cartao" ? (
                      <div style={{ fontSize: 12, color: "var(--cinza)" }}>
                        soma dos gastos do mês
                      </div>
                    ) : null}
                  </td>
                  <td className="esconde-mobile">
                    {l.vencimento ? dataBR(l.vencimento) : "—"}
                  </td>
                  <td className="num">{moeda(l.previsto)}</td>
                  <td>
                    <span className={`selo selo-${l.status}`}>
                      {SELO[l.status]}
                    </span>
                    {l.pago && l.data_pgto ? (
                      <div style={{ fontSize: 12, color: "var(--cinza)" }}>
                        {moeda(l.pagoEfetivo)} em {dataBR(l.data_pgto)}
                      </div>
                    ) : null}
                  </td>
                  <td className="num">
                    {l.pago ? (
                      <form action={desfazerPagamento} className="pagar">
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
                      <form action={pagarConta} className="pagar">
                        <input type="hidden" name="ano" value={ano} />
                        <input type="hidden" name="mes" value={mes} />
                        <input
                          type="hidden"
                          name="conta_id"
                          value={l.conta_id}
                        />
                        <input
                          name="valor_pago"
                          inputMode="decimal"
                          placeholder={l.previsto.toFixed(2).replace(".", ",")}
                          aria-label={`Valor pago de ${l.nome}`}
                        />
                        <button className="btn" type="submit">
                          Pagar
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="vazio">
            O campo ao lado de Pagar é opcional: vazio, vale o previsto.
          </p>
        </section>

        <section>
          <h2>Lançar gasto</h2>
          <form action={novoGasto} className="linha-form">
            <input type="hidden" name="ano" value={ano} />
            <input type="hidden" name="mes" value={mes} />
            <input
              type="date"
              name="data"
              defaultValue={agora.iso}
              aria-label="Data"
            />
            <input
              name="descricao"
              placeholder="descrição"
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
              placeholder="0,00"
              aria-label="Valor"
              required
            />
            <button className="btn" type="submit">
              Lançar
            </button>
          </form>

          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Descrição</th>
                <th className="esconde-mobile">Categoria</th>
                <th className="esconde-mobile">Pago com</th>
                <th className="num">Valor</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {gastos.map((g) => (
                <tr key={g.id}>
                  <td className="num">{dataBR(g.data)}</td>
                  <td>{g.descricao}</td>
                  <td className="esconde-mobile">{g.categoria}</td>
                  <td className="esconde-mobile">{g.pago_com}</td>
                  <td className="num">{moeda(g.valor)}</td>
                  <td className="num">
                    <form action={excluirGasto}>
                      <input type="hidden" name="ano" value={ano} />
                      <input type="hidden" name="mes" value={mes} />
                      <input type="hidden" name="id" value={g.id} />
                      <button
                        className="btn-leve"
                        type="submit"
                        aria-label={`Excluir ${g.descricao}`}
                      >
                        ×
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
            <table>
              <tbody>
                {categorias.map(([nome, valor]) => (
                  <tr key={nome}>
                    <td>{nome}</td>
                    <td className="num">{moeda(valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        <section>
          <details>
            <summary>Ajustes das contas</summary>
            <table>
              <thead>
                <tr>
                  <th>Conta</th>
                  <th className="num">Valor mensal</th>
                  <th className="num">Dia do vencimento</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {contas.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.nome}</strong>
                    </td>
                    <td colSpan={3}>
                      <form action={salvarConta} className="pagar">
                        <input type="hidden" name="ano" value={ano} />
                        <input type="hidden" name="mes" value={mes} />
                        <input type="hidden" name="id" value={c.id} />
                        <input
                          name="valor"
                          inputMode="decimal"
                          defaultValue={
                            c.tipo === "cartao"
                              ? ""
                              : c.valor.toFixed(2).replace(".", ",")
                          }
                          placeholder={
                            c.tipo === "cartao" ? "vem dos gastos" : "0,00"
                          }
                          disabled={c.tipo === "cartao"}
                          aria-label={`Valor de ${c.nome}`}
                        />
                        <input
                          name="dia_vencimento"
                          inputMode="numeric"
                          defaultValue={c.dia_vencimento ?? ""}
                          placeholder="dia"
                          aria-label={`Dia de vencimento de ${c.nome}`}
                          style={{ width: 70 }}
                        />
                        <button className="btn-leve" type="submit">
                          Salvar
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="vazio">
              O valor novo vale deste mês em diante, e só nas contas que ainda
              não foram marcadas como pagas. O dia do vencimento é o que faz uma
              conta aparecer como atrasada.
            </p>
          </details>
        </section>

        <p className="rodape">
          O mês seguinte abre sozinho no dia 1. As faturas dos cartões são a
          soma do que você lançou em Gastos.
        </p>
      </main>
    </>
  );
}
