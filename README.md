# Minhas contas

Painel mensal de contas e gastos, feito para rodar no Vercel e ser usado todo
dia pelo celular. Uma senha só, a sua.

## O que ele faz

- **Abre o mês sozinho.** Toda conta cadastrada aparece no mês novo sem você
  fazer nada. Acontece no dia 1, por uma tarefa agendada, e também na primeira
  vez que você abre a página num mês que ainda não existia.
- **Marca pago.** Um botão por conta. Se pagou valor diferente do previsto,
  digita o valor ao lado; deixando vazio, vale o previsto.
- **Fatura de cartão calculada.** Você não digita o total do Nubank nem do
  Bradesco. Lança as compras em Gastos escolhendo com que cartão pagou, e a
  fatura daquele mês é a soma delas.
- **Atrasado em vermelho.** Depende do dia de vencimento que você cadastra em
  Ajustes das contas.

## Subir no Vercel

1. **Mande o código para o GitHub.** Dentro desta pasta:

   ```bash
   git init && git add . && git commit -m "primeira versao" && git branch -M main
   ```

   Crie um repositório vazio e **privado** no GitHub, depois:

   ```bash
   git remote add origin https://github.com/SEU-USUARIO/contas-app.git && git push -u origin main
   ```

2. **Importe no Vercel.** Em vercel.com, `Add New > Project`, escolha o
   repositório. Ele reconhece Next.js sozinho; não mude nada nas opções de
   build.

3. **Crie o banco.** No projeto, aba `Storage` > `Create Database` > `Postgres`
   > `Connect`. A variável `DATABASE_URL` entra no projeto automaticamente. As
   tabelas se criam no primeiro acesso, já com as sete contas cadastradas.

4. **Defina a senha.** Em `Settings > Environment Variables`, adicione:

   | Nome | Valor |
   | --- | --- |
   | `APP_PASSWORD` | a senha que você vai usar para entrar |
   | `AUTH_SECRET` | uma string aleatória longa (`openssl rand -hex 32`) |
   | `CRON_SECRET` | opcional, outra string aleatória |

5. **Redeploy.** Aba `Deployments`, nos três pontinhos do último deploy,
   `Redeploy`. Variável nova só vale depois disso.

Pronto. Abra a URL, digite a senha e o mês corrente estará montado.

## Rodar na sua máquina

Precisa de Node 18 ou mais novo.

```bash
npm install
```

Copie `.env.example` para `.env.local`, preencha, e:

```bash
npm run dev
```

## Contas cadastradas de início

Carro R$ 1.326,74 · Vaga R$ 200,00 · Faculdade R$ 356,00 · Imposto R$ 180,00 ·
Contador R$ 250,00 · Cartão Nubank e Cartão Bradesco Empresa (calculados pelos
gastos). Valores e dias de vencimento se mudam em Ajustes das contas, dentro da
própria página.

## Onde está cada coisa

| Arquivo | Para que serve |
| --- | --- |
| `app/page.tsx` | o painel inteiro |
| `app/actions.ts` | marcar pago, lançar gasto, salvar ajustes |
| `app/api/cron/route.ts` | abre o mês no dia 1 |
| `lib/data.ts` | as regras: previsto, fatura do cartão, status |
| `lib/db.ts` | conexão e criação das tabelas |
| `lib/auth.ts` | a senha e o cookie |
| `vercel.json` | o agendamento mensal |

## Um aviso sobre a senha

A proteção é uma senha única guardada em variável de ambiente, o suficiente
para manter a página fora do alcance de quem topar com a URL. Não é login com
dois fatores. Escolha uma senha que você não use em outro lugar.
