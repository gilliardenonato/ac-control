import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, openStream } from "./api.ts";
import type { Device, StreamEvent } from "./api.ts";
import { Overview } from "./Overview.tsx";
import { Automations } from "./Automations.tsx";
import { Sessions } from "./Sessions.tsx";
import { Energy } from "./Energy.tsx";
import { Settings } from "./Settings.tsx";
import { Shell } from "./Shell.tsx";
import { useRoute } from "./route.ts";

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState(""); const [err, setErr] = useState("");
  return (
    <main className="login">
      <h1>AC Control</h1>
      <form onSubmit={async (e) => { e.preventDefault(); setErr(""); try { await api.post("/auth/login", { password: pw }); onDone(); } catch (x) { setErr(x instanceof ApiError ? x.title : "Falha ao entrar"); } }}>
        <label className="f">Senha<input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></label>
        <button type="submit" className="btn primary">Entrar</button>
        {err && <p role="alert" className="err small">{err}</p>}
      </form>
    </main>
  );
}

export function App() {
  const [auth, setAuth] = useState<"loading" | "login" | "ok">("loading");
  const [devices, setDevices] = useState<Device[]>([]);
  const [route, go] = useRoute();
  const [live, setLive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [cmdSeq, setCmdSeq] = useState(0);
  const refreshTimer = useRef<number>();

  const load = useCallback(async () => {
    try { setDevices(await api.get<Device[]>("/devices")); setAuth("ok"); }
    catch (e) { setAuth(e instanceof ApiError && e.status === 401 ? "login" : "ok"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (auth !== "ok") return;
    const bump = () => { window.clearTimeout(refreshTimer.current); refreshTimer.current = window.setTimeout(() => setTick((t) => t + 1), 800); };
    return openStream((e: StreamEvent) => {
      if (e.type === "device.state") setDevices((ds) => ds.map((d) => (d.id === e.deviceId ? { ...d, state: e.state, observedAt: e.observedAt } : d)));
      else if (e.type === "command.status") {
        const c = e.command;
        if (c.status !== "pending" && c.status !== "sent") setCmdSeq((n) => n + 1);
        const msg = ({ confirmed: "Comando confirmado pelo aparelho", failed: `Falhou: ${c.errorKind ?? c.skipReason ?? "erro"}`, skipped: c.skipReason === "already_in_state" ? "O aparelho já estava assim" : `Ignorado: ${c.skipReason ?? ""}` } as Record<string, string>)[c.status];
        if (msg) setToast(msg);
        bump();
      } else if (e.type === "breaker.open") { setToast(`Disjuntor aberto: ${e.reason}`); void load(); bump(); }
      else bump();
    }, setLive);
  }, [auth, load]);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 4000); return () => window.clearTimeout(t); }, [toast]);

  if (auth === "loading") return <main className="login"><p className="muted">Carregando…</p></main>;
  if (auth === "login") return <Login onDone={() => { setAuth("loading"); void load(); }} />;
  const dev = devices[0];
  return (
    <Shell route={route} go={go} live={live}>
      {!dev ? <p className="muted">Nenhum aparelho encontrado.</p> : (
        <>
          {route === "/" && <Overview device={dev} tick={tick} cmdSeq={cmdSeq} onToast={setToast} onReload={load} go={go} />}
          {route === "/automacoes" && <Automations device={dev} tick={tick} onToast={setToast} />}
          {route === "/sessoes" && <Sessions device={dev} tick={tick} />}
          {route === "/energia" && <Energy device={dev} tick={tick} />}
          {route === "/config" && <Settings device={dev} onLogout={async () => { await api.post("/auth/logout"); setAuth("login"); }} onToast={setToast} />}
        </>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </Shell>
  );
}
