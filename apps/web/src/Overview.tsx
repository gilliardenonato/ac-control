import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { Dashboard as Dash, Device, Sensor } from "./api.ts";
import { LineChart, Legend } from "./Charts.tsx";
import { ago, brl, dur, kwhN, MODE_LABEL, num1, STATE_LABEL } from "./fmt.ts";
import { Alert, Kpi, Segmented, Stepper } from "./ui.tsx";

interface Sess { id: string; startTs: number; endTs: number | null; durationSec: number; open: boolean; origin: string | null; targetTemp: number | null; estimate: { wh: number | null; costBrl: number | null; provisional: boolean; reason: string | null } }
interface Cmd { id: string; createdAt: number; origin: string; attributes: Record<string, unknown>; status: string; skipReason: string | null; errorKind: string | null; latencyMs: number | null }
const ORIGIN = (o: string | null) => !o ? "—" : o.startsWith("automation:") ? "Automação" : ({ manual: "Manual (aqui)", external: "App/controle", unknown: "Já estava ligado", system: "Sistema" } as Record<string, string>)[o] ?? o;
const ATTR = (a: Record<string, unknown>) => Object.entries(a).map(([k, v]) => k === "power" ? (v ? "ligar" : "desligar") : k === "targetTemp" ? `alvo ${v} °C` : k === "mode" ? `modo ${MODE_LABEL[String(v)] ?? v}` : k === "fan" ? `ventilação ${FAN_LABEL[String(v)] ?? v}` : `${k} ${v}`).join(", ");
const STATUS: Record<string, [string, string]> = { confirmed: ["confirmado", "ok"], sent: ["enviado", "info"], pending: ["pendente", "info"], failed: ["falhou", "warn"], skipped: ["ignorado", ""] };
const FAN_LABEL: Record<string, string> = { low: "Baixo", mid: "Médio", high: "Alto", auto: "Auto", nature: "Natural", low_mid: "Baixo-médio", mid_high: "Médio-alto" };
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

export function Overview({ device, tick, cmdSeq, onToast, onReload, go }: { device: Device; tick: number; cmdSeq: number; onToast: (m: string) => void; onReload: () => void; go: (r: "/config" | "/automacoes" | "/energia" | "/sessoes") => void }) {
  const [dash, setDash] = useState<Dash | null>(null);
  const [hist, setHist] = useState<{ x: number; y: number }[]>([]);
  const [bands, setBands] = useState<{ from: number; to: number }[]>([]);
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [sHist, setSHist] = useState<{ x: number; y: number }[]>([]);
  const [recent, setRecent] = useState<Sess[]>([]);
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const [busy, setBusy] = useState(false);
  const busyTimer = useRef<number>();
  const [now0] = useState(() => Date.now());
  useEffect(() => { void api.get<Dash>(`/devices/${device.id}/dashboard`).then(setDash).catch(() => {}); }, [device.id, tick]);
  useEffect(() => {
    const to = Date.now(), from = to - 24 * 3600_000;
    void api.get<{ ts: number; currentTemp: number | null }[]>(`/devices/${device.id}/history?from=${from}&limit=3000`).then((r) => {
      const b = new Map<number, number[]>(); // médias de 5 min: o sensor oscila ±0,5 °C
      for (const x of r) if (x.currentTemp !== null) { const k = Math.floor(x.ts / 300_000); (b.get(k) ?? b.set(k, []).get(k)!).push(x.currentTemp); }
      setHist([...b].sort((a, c) => a[0] - c[0]).map(([k, v]) => ({ x: k * 300_000 + 150_000, y: v.reduce((s, n) => s + n, 0) / v.length })));
    }).catch(() => {});
    void api.get<Sess[]>(`/devices/${device.id}/sessions?from=${to - 7 * 86400_000}`).then((r) => { setBands(r.map((s) => ({ from: s.startTs, to: s.endTs ?? Date.now() }))); setRecent([...r].reverse().slice(0, 6)); }).catch(() => {});
    void api.get<Cmd[]>(`/devices/${device.id}/commands?limit=8`).then(setCmds).catch(() => {});
    void api.get<Sensor[]>("/sensors").then((list) => {
      setSensors(list);
      const first = list.find((x) => x.deviceId === device.id) ?? list[0];
      if (!first) return setSHist([]);
      void api.get<{ ts: number; temp: number | null }[]>(`/sensors/${first.id}/readings?from=${from}&limit=3000`).then((r) => {
        const b = new Map<number, number[]>();
        for (const x of r) if (x.temp !== null) { const k = Math.floor(x.ts / 300_000); (b.get(k) ?? b.set(k, []).get(k)!).push(x.temp); }
        setSHist([...b].sort((a, c) => a[0] - c[0]).map(([k, v]) => ({ x: k * 300_000 + 150_000, y: v.reduce((s, n) => s + n, 0) / v.length })));
      }).catch(() => {});
    }).catch(() => {});
  }, [device.id, tick]);
  useEffect(() => { setBusy(false); window.clearTimeout(busyTimer.current); }, [cmdSeq]);

  const s = device.state, caps = device.capabilities;
  const send = async (attributes: object) => {
    setBusy(true); window.clearTimeout(busyTimer.current); busyTimer.current = window.setTimeout(() => setBusy(false), 6000);
    try { await api.post(`/devices/${device.id}/commands`, { attributes }); } catch (e: any) { setBusy(false); onToast(e.detail ?? e.title); }
  };
  const tempAge = device.observedAt.currentTemp;
  const stale = tempAge !== undefined && Date.now() - tempAge > 20 * 60_000;
  const p = dash?.projection;
  const goal = p?.goalBrl ?? null, monthCost = dash?.month.costBrl ?? null, projCost = p?.projectedCostBrl ?? null;
  const goalStatus = goal === null || projCost === null ? undefined : projCost > goal ? "crit" : (monthCost ?? 0) > goal * 0.9 ? "warn" : "ok";
  const running = dash?.automations.filter((a) => a.enabled && a.state === "RUNNING") ?? [];
  const online = s.online !== false;
  const sensor = sensors.find((x) => x.deviceId === device.id) ?? sensors[0];
  const useSensor = !!sensor && sensor.online && sensor.temperature !== null;
  const roomTemp = useSensor ? sensor!.temperature! : s.currentTemp;
  const usedBySensorRule = (dash?.automations ?? []).some((a) => a.enabled && /sensor/i.test(a.description.when));
  // a escala acompanha o histórico que existe (até 24 h) em vez de deixar o gráfico vazio
  const xEnd = hist.length ? Math.max(now0, hist.at(-1)!.x) : now0;
  const spanMs = hist.length ? Math.min(24 * 3600_000, xEnd - hist[0]!.x + 5 * 60_000) : 24 * 3600_000;
  const xStart = xEnd - Math.max(spanMs, 15 * 60_000);
  const hourTicks = (() => {
    const steps = [5, 10, 15, 30, 60, 120, 240].map((m) => m * 60_000); const step = steps.find((s) => (xEnd - xStart) / s <= 7) ?? steps.at(-1)!;
    const t: number[] = []; for (let v = Math.ceil(xStart / step) * step; v <= xEnd; v += step) t.push(v); return t;
  })();
  const temps = hist.map((h) => h.y).concat(s.targetTemp !== undefined ? [s.targetTemp] : []);
  const yDomain: [number, number] | undefined = temps.concat(sHist.map((h) => h.y)).length ? [Math.floor(Math.min(...temps, ...sHist.map((h) => h.y))) - 1, Math.ceil(Math.max(...temps, ...sHist.map((h) => h.y))) + 1] : undefined;

  return (
    <>
      <div className="pagehead">
        <h1>{device.name}</h1>
        <span className="state"><span className={`dot ${online ? "ok" : "crit"}`} />{online ? "online" : "offline"}</span>
        {device.model && <span className="muted mono">{device.model}</span>}
      </div>

      <div className="alerts" aria-live="polite">
        {dash?.breaker && <Alert kind="crit"><span>Automações pausadas pelo disjuntor: {dash.breaker.reason}.</span><button className="btn sm" onClick={async () => { await api.post(`/devices/${device.id}/breaker/reset`); onReload(); onToast("Disjuntor resetado; retome as automações."); }}>Resetar disjuntor</button></Alert>}
        {!online && <Alert kind="crit">Aparelho offline. Os controles ficam indisponíveis até ele voltar.</Alert>}
        {stale && <Alert kind="warn">Temperatura sem atualização há {ago(tempAge)}. Automações por temperatura ficam em espera.</Alert>}
        {sensor && !sensor.online && usedBySensorRule && <Alert kind="warn">O sensor “{sensor.name}” está sem enviar dados {sensor.lastSeenAt ? `desde ${hhmm(sensor.lastSeenAt)}` : "(nunca enviou)"}. A automação que usa esse sensor fica em espera.</Alert>}
        {dash?.energy.needsScope && <Alert kind="warn">{dash.energy.lastError}</Alert>}
        {dash && !dash.tariffConfigured && <Alert kind="info"><span>Configure a tarifa (R$/kWh) para ver custos.</span><button className="linkbtn" onClick={() => go("/config")}>Abrir configurações</button></Alert>}
      </div>

      <div className="g12">
        <section className="card hero c4" aria-label="Estado e controles">
          <div>
            <div className="label">{useSensor ? `Temperatura da sala · ${sensor!.name}` : "Temperatura ambiente"}</div>
            <div className="temp"><span className="big">{roomTemp !== undefined ? num1(roomTemp, 1) : "—"}</span><span className="unit">°C</span></div>
            <div className="state" style={{ marginTop: ".4rem" }}><span className={`dot ${s.power ? "ok" : ""}`} />{s.power === undefined ? "estado desconhecido" : s.power ? `Ligado${s.mode ? ` · ${MODE_LABEL[s.mode] ?? s.mode}` : ""}` : "Desligado"} · atualizado {ago(useSensor ? sensor!.lastSeenAt ?? undefined : tempAge)}</div>
            {useSensor && <div className="muted small" style={{ marginTop: ".25rem" }}>Sensor do ar: {s.currentTemp !== undefined ? `${num1(s.currentTemp, 1)} °C` : "—"}{sensor!.humidity !== null ? ` · umidade da sala ${Math.round(sensor!.humidity)}%` : ""}</div>}
          </div>
          <div className="controls">
            <div>
              <button type="button" className={`btn power ${s.power ? "on" : "primary"}`} disabled={!online || busy} onClick={() => send({ power: !s.power })}>{s.power ? "Ligado — tocar para desligar" : "Desligado — tocar para ligar"}</button>
              {busy && <div className="muted small" role="status" style={{ marginTop: ".25rem" }}>enviando comando…</div>}
            </div>
            {caps?.temperature && s.targetTemp !== undefined && <div className="ctl"><span className="label">Temperatura alvo</span><Stepper label="Temperatura alvo" value={s.targetTemp} min={caps.temperature.min} max={caps.temperature.max} step={caps.temperature.step} unit="°C" disabled={!online || busy} onChange={(v) => send({ targetTemp: v })} /></div>}
            {caps && caps.modes.length > 0 && <div className="ctl"><span className="label">Modo</span><Segmented full label="Modo" value={s.mode} disabled={!online || busy} options={caps.modes.map((m) => ({ value: m, label: MODE_LABEL[m] ?? m }))} onChange={(v) => send({ mode: v })} /></div>}
            {caps?.fan && <div className="ctl"><span className="label">Ventilação</span><Segmented full label="Ventilação" value={s.fan} disabled={!online || busy} options={caps.fan.values.map((m) => ({ value: m, label: FAN_LABEL[m] ?? m }))} onChange={(v) => send({ fan: v })} /></div>}
          </div>
        </section>

        <section className="card c5" aria-label="Temperatura nas últimas 24 horas">
          <header>
            <div><h3>Temperatura</h3><p>{hist.length > 1 ? `Desde ${hhmm(xStart)} (até 24 h). ` : ""}Ambiente (média de 5 min), alvo e períodos em que o aparelho esteve ligado.</p></div>
            <Legend items={[{ name: "sensor do ar", cls: "a" }, ...(sHist.length ? [{ name: sensor?.name ?? "sensor", cls: "c" }] : []), { name: "alvo", cls: "b", dashed: true }]} />
          </header>
          {hist.length > 1 ? (
            <LineChart ariaLabel="Temperatura ambiente nas últimas 24 horas" height={300} xDomain={[xStart, xEnd]} xTicks={hourTicks} xFormat={hhmm} yFormat={(v) => `${Math.round(v)}°`} yDomain={yDomain}
              bands={bands} hlines={s.targetTemp !== undefined ? [{ y: s.targetTemp, label: `alvo ${num1(s.targetTemp, 1)}°` }] : []}
              series={[{ id: "t", name: "ar", cls: "a", points: hist, area: !sHist.length }, ...(sHist.length ? [{ id: "s", name: sensor?.name ?? "sensor", cls: "c" as const, points: sHist }] : [])]}
              tip={(x, v) => ({ title: hhmm(x), rows: [["Sensor do ar", v[0]?.y != null ? `${num1(v[0].y, 1)} °C` : "—"], ...(sHist.length ? [[sensor?.name ?? "Sensor", v[1]?.y != null ? `${num1(v[1].y, 1)} °C` : "—"] as [string, string]] : []), ["Aparelho", bands.some((b) => x >= b.from && x <= b.to) ? "ligado" : "desligado"]] })} />
          ) : <p className="muted small">Sem histórico suficiente ainda.</p>}
          <div className="legend"><span><i style={{ background: "var(--ok)", opacity: 0.5 }} />faixa verde = aparelho ligado</span></div>
        </section>

        <div className="c3 stack" style={{ alignContent: "start" }}>
        <section className="card" aria-label="Sensores">
          <header><div><h3>Sensores da sala</h3><p>Temperatura e umidade enviadas pelo ESP32.</p></div><button className="linkbtn small" onClick={() => go("/config")}>gerenciar</button></header>
          {sensors.length === 0 ? <><p className="empty">Nenhum sensor conectado.</p><div><button className="btn" onClick={() => go("/config")}>Conectar sensor</button></div></> : sensors.map((x) => (
            <div key={x.id} className="sensor">
              <div className="row between"><strong>{x.name}</strong><span className={`pill ${x.online ? "ok" : "warn"}`}>{x.online ? "online" : "sem dados"}</span></div>
              <div><span className="big">{x.temperature !== null ? num1(x.temperature, 1) : "—"}</span><span className="unit">°C</span></div>
              <div className="meta"><span>Umidade <b>{x.humidity !== null ? `${Math.round(x.humidity)}%` : "—"}</b></span><span>atualizado {ago(x.lastSeenAt ?? undefined)}</span></div>
            </div>))}
        </section>
        <section className="card" aria-label="Automação">
          <header><div><h3>Automação</h3>{running.length > 0 && <p><span className="tag">AUTOMAÇÃO ATIVA</span></p>}</div><button className="linkbtn small" onClick={() => go("/automacoes")}>gerenciar</button></header>
          {!dash?.automations.filter((a) => a.enabled).length && <><p className="empty">Nenhuma automação ativa. Crie uma para ligar e desligar o ar por temperatura e horário, com proteções.</p><div><button className="btn" onClick={() => go("/automacoes")}>Criar automação</button></div></>}
          <div className="stack">
            {dash?.automations.filter((a) => a.enabled).map((a) => (
              <div key={a.ruleId} className={`auto ${a.state === "RUNNING" ? "active" : ""}`}>
                <div className="row between"><strong>{a.name}</strong><span className={`pill ${a.state === "RUNNING" ? "ok" : a.state === "SUSPENDED" ? "warn" : a.state === "ARMED" ? "info" : ""}`}>{STATE_LABEL[a.state] ?? a.state}</span></div>
                <div className="rule-line"><b>Quando</b><span>{a.description.when}</span></div>
                <div className="rule-line"><b>Então</b><span>{a.description.then}</span></div>
                {a.description.until && <div className="rule-line"><b>Até</b><span>{a.description.until}{a.description.onEnd ? ` → ${a.description.onEnd}` : ""}</span></div>}
                {a.reason && <p className="muted small">{a.reason}</p>}
              </div>
            ))}
          </div>
        </section>
        </div>

        <div className="c2"><Kpi label="Ligado hoje" value={dash ? dur(dash.onTodayMinutes) : "—"} detail={dash?.onTodaySince ? `desde ${hhmm(dash.onTodaySince)} (início do monitoramento)` : "tempo com o aparelho ligado"} /></div>
        <div className="c2"><Kpi label="Consumo hoje" basis={dash?.today.basis} value={kwhN(dash?.today.wh, 2)} unit="kWh" detail={dash?.today.provisional ? "parcial; a LG atualiza a cada ~5–10 min" : dash && dash.today.basis === null ? (dash.energy.supported === false ? "aparelho não informa consumo" : "aguardando a primeira coleta") : undefined} /></div>
        <div className="c2"><Kpi label="Custo hoje" basis={dash?.today.basis} value={brl(dash?.today.costBrl)} detail={dash?.today.provisional ? "parcial" : undefined} /></div>
        <div className="c2"><Kpi label="Consumo no mês" basis={dash?.month.basis} value={kwhN(dash?.month.wh, 1)} unit="kWh" detail={dash?.month.daysWithData ? `${dash.month.daysWithData} dias com dados` : undefined} /></div>
        <div className="c2"><Kpi label="Custo no mês" basis={dash?.month.basis} value={brl(dash?.month.costBrl)} detail={p?.previousMonthCostMicro != null ? `mês anterior: ${brl(p.previousMonthCostMicro / 1e6)}` : undefined} /></div>
        <div className="c2"><Kpi label="Projeção do mês" basis={projCost !== null ? "estimated" : null} status={goalStatus} value={brl(projCost)}
          detail={projCost !== null && p?.lowCostMicro != null && p.highCostMicro != null ? `faixa ${brl(p.lowCostMicro / 1e6)}–${brl(p.highCostMicro / 1e6)}${goal !== null ? ` · meta ${brl(goal)}` : ""}` : "precisa de dias fechados no mês"} /></div>

        <section className="card c7" aria-label="Sessões recentes">
          <header><div><h3>Sessões recentes</h3><p>Cada vez que o aparelho ligou e desligou (últimos 7 dias).</p></div><button className="linkbtn small" onClick={() => go("/sessoes")}>ver todas</button></header>
          {recent.length === 0 ? <p className="empty">Nenhuma sessão registrada ainda.</p> : (
            <div className="scrollx"><table className="mini"><thead><tr><th>Início</th><th>Duração</th><th>Origem</th><th className="r">Consumo <span className="badge estimated">ESTIMADO</span></th><th className="r">Custo</th></tr></thead>
              <tbody>{recent.map((r) => (
                <tr key={r.id}><td>{new Date(r.startTs).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}{r.open && <> <span className="pill ok">agora</span></>}</td><td>{dur(r.durationSec / 60)}</td><td>{ORIGIN(r.origin)}</td>
                  <td className="r" title={r.estimate.reason ?? "Estimado pela diferença do contador de energia da LG"}>{r.estimate.wh === null ? "—" : `${kwhN(r.estimate.wh, 2)} kWh${r.estimate.provisional ? " *" : ""}`}</td><td className="r">{brl(r.estimate.costBrl)}</td></tr>))}</tbody></table></div>)}
        </section>

        <section className="card c5" aria-label="Últimos comandos">
          <header><div><h3>Últimos comandos</h3><p>O que foi enviado ao aparelho e o resultado.</p></div></header>
          {cmds.length === 0 ? <p className="empty">Nenhum comando enviado por aqui ainda.</p> : (
            <div className="scrollx"><table className="mini"><tbody>{cmds.map((c) => { const [label, tone] = STATUS[c.status] ?? [c.status, ""]; return (
              <tr key={c.id}><td className="muted">{hhmm(c.createdAt)}</td><td>{ATTR(c.attributes)}<div className="muted small">{ORIGIN(c.origin)}{c.skipReason ? ` · ${c.skipReason === "already_in_state" ? "já estava assim" : c.skipReason}` : ""}{c.errorKind ? ` · ${c.errorKind}` : ""}</div></td>
                <td className="r"><span className={`pill ${tone}`}>{label}</span>{c.latencyMs ? <div className="muted small">{num1(c.latencyMs / 1000, 1)} s</div> : null}</td></tr>); })}</tbody></table></div>)}
        </section>

        {goal !== null && projCost !== null && (
          <section className="card c12" aria-label="Meta do mês">
            <header><div><h3>Meta do mês</h3><p>{brl(monthCost)} gastos de {brl(goal)} · {p!.diffToGoalMicro! > 0 ? `a projeção passa a meta em ${brl(p!.diffToGoalMicro! / 1e6)}` : `a projeção fica ${brl(-p!.diffToGoalMicro! / 1e6)} abaixo da meta`}</p></div></header>
            <div className={`progress ${goalStatus === "crit" ? "crit" : goalStatus === "warn" ? "warn" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(monthCost ?? 0, goal)}><span style={{ width: `${Math.min(100, ((monthCost ?? 0) / goal) * 100)}%` }} /></div>
          </section>
        )}
      </div>
    </>
  );
}
