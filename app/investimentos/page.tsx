import { redirect } from "next/navigation";
import { estaLogado } from "@/lib/auth";
import { lerConfigBancos } from "@/lib/bancos";
import {
  lerCarteira,
  rendimento,
  rotuloSubtipo,
  rotuloTipo,
  type Carteira,
  type Investimento,
} from "@/lib/investimentos";
import { dataBR, moeda } from "@/lib/format";
import { sairAction, sincronizarAgoraAction } from "../actions";

export const dynamic = "force-dynamic";
// "Atualizar agora" sincroniza com os bancos e pode levar alguns segundos.
export const maxDuration = 60;

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

/** O que da para dizer de um investimento numa linha: tipo, rendimento,
 *  vencimento e banco, so o que o banco informou. */
function detalhe(i: Investimento): string {
  return [
    rotuloSubtipo(i.subtipo) ?? rotuloTipo(i.tipo),
    rendimento(i),
    i.vencimento ? `vence ${dataBR(i.vencimento)}` : "",
    i.banco,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default async function Investimentos() {
  if (!(await estaLogado())) redirect("/login");

  let carteira: Carteira | null = null;
  let conectado = false;
  let falha: string | null = null;
  try {
    [carteira, conectado] = await Promise.all([
      lerCarteira(),
      lerConfigBancos().then((c) => c.configurado),
    ]);
  } catch (e) {
    falha = e instanceof Error ? e.message : String(e);
  }

  const primeiro = carteira?.historico[0];
  const variacao =
    carteira && primeiro && carteira.historico.length > 1
      ? carteira.total - primeiro.investido
      : null;

  return (
    <>
      <header className="topo">
        <div className="topo-interno">
          <h1>Investimentos</h1>
          <a className="sair" href="/">
            Contas
          </a>
          <form action={sairAction}>
            <button className="sair" type="submit">
              Sair
            </button>
          </form>
        </div>
      </header>

      <main className="pagina">
        {falha ? (
          <div className="aviso">
            <strong>Banco de dados não respondeu.</strong>
            <br />
            <small>{falha}</small>
          </div>
        ) : null}

        {carteira && carteira.ativos.length === 0 && carteira.encerrados.length === 0 ? (
          <section>
            <h2>Nada por aqui ainda</h2>
            <p className="vazio">
              {conectado
                ? "Os investimentos chegam na próxima sincronização com os bancos. Toque em Atualizar agora para buscar já."
                : "Os investimentos vêm dos bancos conectados pelo Meu Pluggy. Conecte os bancos na seção Bancos, na tela de contas."}
            </p>
            {conectado ? (
              <form action={sincronizarAgoraAction} className="banco-sync">
                <input type="hidden" name="volta" value="/investimentos" />
                <button className="btn" type="submit">
                  Atualizar agora
                </button>
              </form>
            ) : null}
          </section>
        ) : null}

        {carteira && (carteira.ativos.length > 0 || carteira.encerrados.length > 0) ? (
          <>
            <div className="cartoes">
              <div className="cartao cartao-bom">
                <span>Total investido</span>
                <strong>{moeda(carteira.total)}</strong>
                <div className="sub">
                  {variacao != null && primeiro
                    ? `${variacao >= 0 ? "+" : "−"}${moeda(Math.abs(variacao))} desde ${dataBR(primeiro.data)}`
                    : "saldo líquido, depois de imposto"}
                </div>
              </div>
              <div className="cartao">
                <span>Em conta</span>
                <strong>{moeda(carteira.emConta)}</strong>
              </div>
              <div className="cartao">
                <span>Investido + em conta</span>
                <strong>{moeda(carteira.total + carteira.emConta)}</strong>
              </div>
            </div>

            {carteira.ativos.length > 0 ? (
              <section>
                <h2>Onde está o dinheiro</h2>
                {carteira.ativos.map((i) => (
                  <div className="gasto" key={i.id}>
                    <strong className="gasto-desc">{i.nome}</strong>
                    <span className="num gasto-valor">{moeda(i.saldo)}</span>
                    <span className="sub gasto-meta">
                      {detalhe(i)}
                      {i.aplicado != null && i.aplicado > 0
                        ? ` · aplicado ${moeda(i.aplicado)}`
                        : ""}
                    </span>
                  </div>
                ))}
              </section>
            ) : (
              <section>
                <h2>Onde está o dinheiro</h2>
                <p className="vazio">Nenhum investimento com saldo no momento.</p>
              </section>
            )}

            {carteira.porTipo.length > 1 ? (
              <section>
                <h2>Por tipo</h2>
                <div className="cat-lista">
                  {carteira.porTipo.map(([nome, valor]) => (
                    <div className="cat-item" key={nome}>
                      <span>{nome}</span>
                      <span className="num">{moeda(valor)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {carteira.porBanco.length > 1 ? (
              <section>
                <h2>Por banco</h2>
                <div className="cat-lista">
                  {carteira.porBanco.map(([nome, valor]) => (
                    <div className="cat-item" key={nome}>
                      <span>{nome}</span>
                      <span className="num">{moeda(valor)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {carteira.historico.length > 1 ? (
              <section>
                <h2>Evolução</h2>
                <div className="cat-lista">
                  {[...carteira.historico]
                    .reverse()
                    .slice(0, 12)
                    .map((r) => (
                      <div className="cat-item" key={r.data}>
                        <span>{dataBR(r.data)}</span>
                        <span className="num">{moeda(r.investido)}</span>
                      </div>
                    ))}
                </div>
              </section>
            ) : null}

            {carteira.encerrados.length > 0 ? (
              <section>
                <details>
                  <summary>Já resgatados ({carteira.encerrados.length})</summary>
                  <div className="cat-lista">
                    {carteira.encerrados.map((i) => (
                      <div className="cat-item" key={i.id}>
                        <span>
                          {i.nome}
                          <span className="sub"> · {detalhe(i)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              </section>
            ) : null}

            <form action={sincronizarAgoraAction} className="banco-sync">
              <input type="hidden" name="volta" value="/investimentos" />
              <button className="btn" type="submit">
                Atualizar agora
              </button>
            </form>
            <p className="rodape">
              {carteira.atualizado
                ? `Atualizado em ${quandoBR(carteira.atualizado)}. `
                : ""}
              Os valores vêm dos bancos conectados pelo Meu Pluggy, uma vez por
              dia. A evolução guarda um ponto a cada dia de sincronização.
            </p>
          </>
        ) : null}
      </main>
    </>
  );
}
