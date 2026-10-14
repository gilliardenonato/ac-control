import { useEffect, useState } from "react";
import { NAV } from "./route.ts";
import type { Route } from "./route.ts";

function ThemeToggle() {
  const [light, setLight] = useState(() => document.documentElement.classList.contains("light"));
  useEffect(() => { document.documentElement.classList.toggle("light", light); document.documentElement.classList.toggle("dark", !light); try { localStorage.setItem("theme", light ? "light" : "dark"); } catch { /* sem storage */ } }, [light]);
  return (
    <button type="button" className="themebtn" onClick={() => setLight(!light)} aria-label={light ? "Ativar tema escuro" : "Ativar tema claro"}>
      {light
        ? <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13 8.5A5.5 5.5 0 017 2a6 6 0 106 6.5z" /></svg>
        : <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="3" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4" /></svg>}
    </button>
  );
}

export function Shell({ route, go, live, children }: { route: Route; go: (r: Route) => void; live: boolean; children: React.ReactNode }) {
  const link = (href: Route, label: string) => (
    <button key={href} type="button" className={`navlink ${route === href ? "active" : ""}`} aria-current={route === href ? "page" : undefined} onClick={() => go(href)}>{label}</button>
  );
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Principal">
        <div className="brand"><span>AC Control</span><ThemeToggle /></div>
        <ul className="navlist navgroups">{NAV.map((i) => <li key={i.href}>{link(i.href, i.label)}</li>)}</ul>
        <div className="livedot" role="status"><span className={`dot ${live ? "ok" : "crit"}`} />{live ? "Tempo real conectado" : "Reconectando…"}</div>
      </nav>
      <div className="main">
        <nav className="mobilenav" aria-label="Principal">
          <div className="scroll">{NAV.map((i) => link(i.href, i.label))}</div>
          <span className={`dot ${live ? "ok" : "crit"}`} role="status" aria-label={live ? "Tempo real conectado" : "Reconectando"} />
          <ThemeToggle />
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
