"use client";

import { useEffect } from "react";

/**
 * O servidor do Vercel roda em UTC, entao o mes que ele escolhe pode nao ser
 * o mes do seu aparelho na virada. Aqui, ao abrir a pagina sem pedir um mes
 * especifico, conferimos o calendario do proprio celular ou computador e
 * corrigimos se estiver diferente.
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
    if (explicito) return;
    const agora = new Date();
    const a = agora.getFullYear();
    const m = agora.getMonth() + 1;
    if (a !== ano || m !== mes) {
      window.location.replace(`/?ano=${a}&mes=${m}`);
    }
  }, [ano, mes, explicito]);

  return null;
}
