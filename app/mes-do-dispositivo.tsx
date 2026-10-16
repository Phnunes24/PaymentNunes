"use client";

import { useEffect } from "react";

const CHAVE = "contas_sessao";

/**
 * Garante que o app abre no mes de hoje.
 *
 * Abrir o app (atalho da tela inicial, aba nova, navegador reaberto) comeca
 * uma sessao nova, e ai vamos sempre para o mes de hoje no calendario do
 * proprio aparelho, mesmo que o endereco salvo traga outro mes. Navegar pelas
 * setas dentro da mesma sessao respeita o mes escolhido.
 *
 * Tambem cobre a virada do mes: o servidor do Vercel roda em UTC e pode
 * escolher um mes diferente do aparelho perto da meia-noite.
 */
export default function MesDoDispositivo({
  ano,
  mes,
  explicito,
}: {
  ano: number;
  mes: number;
  explicito: boolean;
}) {
  useEffect(() => {
    const agora = new Date();
    const a = agora.getFullYear();
    const m = agora.getMonth() + 1;

    let abertura = false;
    try {
      abertura = !window.sessionStorage.getItem(CHAVE);
      window.sessionStorage.setItem(CHAVE, "1");
    } catch {
      // sessionStorage bloqueado (aba anonima em alguns navegadores): sem como
      // saber se e abertura, respeitamos o mes do endereco para as setas
      // continuarem funcionando.
    }

    const foraDeHoje = a !== ano || m !== mes;
    if (foraDeHoje && (abertura || !explicito)) {
      window.location.replace(`/?ano=${a}&mes=${m}`);
    }
  }, [ano, mes, explicito]);

  return null;
}
