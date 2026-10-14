import { useEffect, useState } from "react";
export type Route = "/" | "/automacoes" | "/sessoes" | "/energia" | "/config";
export const NAV: { href: Route; label: string }[] = [
  { href: "/", label: "Visão geral" }, { href: "/automacoes", label: "Automações" },
  { href: "/sessoes", label: "Sessões" }, { href: "/energia", label: "Energia" }, { href: "/config", label: "Configurações" },
];
const ALL = NAV.map((i) => i.href);
const read = (): Route => { const h = location.hash.replace(/^#/, "") || "/"; return (ALL.includes(h as Route) ? h : "/") as Route; };
/** Rota por hash: links diretos e botão voltar funcionam sem biblioteca. */
export function useRoute(): [Route, (r: Route) => void] {
  const [r, setR] = useState<Route>(read);
  useEffect(() => { const f = () => setR(read()); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  return [r, (n) => { location.hash = n; }];
}
