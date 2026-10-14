import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.ts";
import type { Device, Sensor } from "./api.ts";
import { MODE_LABEL, STATE_LABEL, time } from "./fmt.ts";

interface Desc { when: string; then: string; until: string | null; onEnd: string | null }
interface Rule { id: string; name: string; enabled: boolean; priority: number; description: Desc; state: { state: string; reason: string | null; untilTs: number | null } | null }
interface Run { id: string; startedAt: number; endedAt: number | null; outcome: string | null }
const OUTCOME: Record<string, string> = { until: "chegou na temperatura de saída", maxRuntime: "tempo máximo", runFor: "tempo definido", overridden: "você mexeu no aparelho", preempted: "outra regra assumiu", device_off: "aparelho desligado", blocked: "bloqueada por proteção", done: "concluída", end_failed: "não conseguiu desligar" };

const DAYS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
interface Form { sensorId: string; name: string; priority: number; onTemp: number; onFor: number; useWindow: boolean; from: string; to: string; days: boolean[]; power: boolean; mode: string; target: number; fan: string;
  offTemp: number; offFor: number; turnOff: boolean; maxH: number; cooldownMin: number; minOnMin: number; minOffMin: number; maxCmdH: number }
const DEFAULT: Form = { sensorId: "", name: "Noite quente", priority: 50, onTemp: 27, onFor: 10, useWindow: true, from: "20:00", to: "06:00", days: Array(7).fill(true), power: true, mode: "cool", target: 23, fan: "auto",
  offTemp: 24, offFor: 2, turnOff: true, maxH: 8, cooldownMin: 30, minOnMin: 10, minOffMin: 5, maxCmdH: 6 };

function toInput(f: Form, deviceId: string) {
  const src = f.sensorId ? { sensor: f.sensorId } : {};
  const conds: any[] = [{ type: "temp", ...src, op: ">=", value: f.onTemp, forSec: f.onFor * 60 }];
  if (f.useWindow) conds.push({ type: "timeWindow", from: f.from, to: f.to });
  if (f.days.some((d) => !d)) conds.push({ type: "weekday", in: f.days.flatMap((d, i) => (d ? [i + 1] : [])) });
  const attrs: any = { type: "setAttributes", power: f.power };
  if (f.mode) attrs.mode = f.mode; if (f.target) attrs.targetTemp = f.target; if (f.fan) attrs.fan = f.fan;
  return {
    name: f.name, deviceId, enabled: true, priority: f.priority,
    when: conds.length === 1 ? conds[0] : { type: "all", of: conds },
    actions: [attrs],
    until: f.power ? { type: "temp", ...src, op: "<=", value: f.offTemp, forSec: f.offFor * 60 } : undefined,
    onEnd: f.power && f.turnOff ? [{ type: "setAttributes", power: false }] : undefined,
    guards: { maxRuntimeSec: f.maxH * 3600, cooldownSec: f.cooldownMin * 60, minOnSec: f.minOnMin * 60, minOffSec: f.minOffMin * 60, maxCommandsPerHour: f.maxCmdH },
  };
}

const Lines = ({ d }: { d: Desc }) => (
  <>
    <div className="rule-line"><b>Quando</b><span>{d.when}</span></div>
    <div className="rule-line"><b>Então</b><span>{d.then}</span></div>
    {d.until && <div className="rule-line"><b>Até</b><span>{d.until}</span></div>}
    {d.onEnd && <div className="rule-line"><b>Depois</b><span>{d.onEnd}</span></div>}
  </>
);

export function Automations({ device, tick, onToast }: { device: Device; tick: number; onToast: (m: string) => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [f, setF] = useState<Form>(DEFAULT);
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<Desc | null>(null);
  const [runs, setRuns] = useState<Record<string, Run[]>>({});
  const [open, setOpen] = useState(false);
  const caps = device.capabilities;
  const [sensors, setSensors] = useState<Sensor[]>([]);
  useEffect(() => { void api.get<Sensor[]>("/sensors").then(setSensors); }, [tick]);
  const load = useCallback(() => { void api.get<Rule[]>(`/automations?deviceId=${device.id}`).then(setRules); }, [device.id]);
  useEffect(load, [load, tick]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  // pré-visualização ao vivo: valida no servidor (mesmas regras de segurança) enquanto a pessoa edita
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const my = ++seq.current;
    const t = window.setTimeout(async () => {
      try { const r = await api.post<{ valid: boolean; errors: string[]; description: Desc }>("/automations/validate", toInput(f, device.id)); if (my === seq.current) { setErrors(r.errors); setPreview(r.description); } }
      catch (e) { if (my === seq.current) { setErrors(e instanceof ApiError ? [e.title, ...(e.errors ?? [])] : ["erro"]); setPreview(null); } }
    }, 350);
    return () => window.clearTimeout(t);
  }, [f, open, device.id]);

  const save = async () => {
    try { await api.post("/automations", toInput(f, device.id)); onToast("Automação criada"); setOpen(false); load(); }
    catch (e) { setErrors(e instanceof ApiError ? e.errors ?? [e.title] : ["erro"]); }
  };
  const act = async (id: string, a: "enable" | "disable" | "resume") => { try { await api.post(`/automations/${id}/${a}`); load(); } catch (e: any) { onToast(e.title); } };

  return (
    <>
      <div className="pagehead"><h1>Automações</h1><span className="sub">Regras “quando → então → até”, sempre com proteções contra oscilação.</span><span className="grow" /><button className="btn primary" onClick={() => setOpen(!open)}>{open ? "Cancelar" : "Nova automação"}</button></div>
      <p className="muted small" style={{ marginTop: 0 }}>Proteções sempre ativas: histerese, debounce, tempo mínimo ligado/desligado, espera após executar, tempo máximo, limite de comandos por hora e pausa quando você mexe no aparelho.</p>

      <div className="g12" style={{ alignItems: "start" }}>
        <div className={`stack ${open ? "c7" : "c12"}`}>
          {rules.length === 0 && <section className="card"><p className="muted" style={{ margin: 0 }}>Nenhuma automação ainda. Crie a primeira em “Nova automação”.</p></section>}
          {rules.map((r) => (
            <section key={r.id} className={`card auto ${r.state?.state === "RUNNING" ? "active" : ""}`} aria-label={r.name}>
              <div className="row between"><strong>{r.name}</strong><span className={`pill ${!r.enabled ? "" : r.state?.state === "RUNNING" ? "ok" : r.state?.state === "SUSPENDED" ? "warn" : r.state?.state === "ARMED" ? "info" : ""}`}>{r.enabled ? STATE_LABEL[r.state?.state ?? "IDLE"] : "Desativada"}</span></div>
              <Lines d={r.description} />
              {r.state?.reason && <p className="muted small">{r.state.reason}{r.state.untilTs ? ` (até ${time(r.state.untilTs)})` : ""}</p>}
              <div className="row">
                <button className="btn sm" onClick={() => act(r.id, r.enabled ? "disable" : "enable")}>{r.enabled ? "Desativar" : "Ativar"}</button>
                {r.state?.state === "SUSPENDED" && <button className="btn sm" onClick={() => act(r.id, "resume")}>Retomar</button>}
                <button className="btn sm" onClick={async () => setRuns({ ...runs, [r.id]: runs[r.id] ? [] : await api.get<Run[]>(`/automations/${r.id}/runs`) })}>Execuções</button>
                <button className="btn sm danger" onClick={async () => { if (confirm(`Excluir "${r.name}"?`)) { await api.del(`/automations/${r.id}`); load(); } }}>Excluir</button>
              </div>
              {runs[r.id] && <ul className="small muted" style={{ margin: 0, paddingLeft: "1.1rem" }}>{runs[r.id]!.length === 0 ? <li>Sem execuções.</li> : runs[r.id]!.map((x) => <li key={x.id}>{time(x.startedAt)} → {x.endedAt ? time(x.endedAt) : "em andamento"} · {x.outcome ? OUTCOME[x.outcome] ?? x.outcome : "—"}</li>)}</ul>}
            </section>
          ))}
        </div>

        {open && (
          <form className="stack c5" aria-label="Nova automação" onSubmit={(e) => { e.preventDefault(); if (!errors.length) void save(); }}>
            <section className="card stack">
              <label className="f">Nome<input value={f.name} onChange={(e) => set("name", e.target.value)} required maxLength={80} /></label>
              <fieldset><legend>1 · Quando</legend>
                <label className="f">Fonte da temperatura<select value={f.sensorId} onChange={(e) => set("sensorId", e.target.value)}><option value="">Sensor do próprio ar-condicionado</option>{sensors.map((x) => <option key={x.id} value={x.id}>{x.name} (sensor externo)</option>)}</select></label>
                <div className="grid2">
                  <label className="f">Temperatura ≥ (°C)<input type="number" step="0.5" value={f.onTemp} onChange={(e) => set("onTemp", +e.target.value)} /></label>
                  <label className="f">por pelo menos (min)<input type="number" min={0} value={f.onFor} onChange={(e) => set("onFor", +e.target.value)} /></label>
                </div>
                <label className="f inline"><input type="checkbox" checked={f.useWindow} onChange={(e) => set("useWindow", e.target.checked)} /> Só neste horário</label>
                {f.useWindow && <div className="grid2"><label className="f">De<input type="time" value={f.from} onChange={(e) => set("from", e.target.value)} /></label><label className="f">Até<input type="time" value={f.to} onChange={(e) => set("to", e.target.value)} /></label></div>}
                <div className="days" role="group" aria-label="Dias da semana">{DAYS.map((d, i) => <label key={d} className="f inline"><input type="checkbox" checked={f.days[i]} onChange={(e) => set("days", f.days.map((x, j) => (j === i ? e.target.checked : x)))} />{d}</label>)}</div>
              </fieldset>
              <fieldset><legend>2 · Então</legend>
                <label className="f inline"><input type="checkbox" checked={f.power} onChange={(e) => set("power", e.target.checked)} /> Ligar o aparelho</label>
                <div className="grid2">
                  {caps && <label className="f">Modo<select value={f.mode} onChange={(e) => set("mode", e.target.value)}><option value="">(manter)</option>{caps.modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m] ?? m}</option>)}</select></label>}
                  {caps?.temperature && <label className="f">Alvo (°C)<input type="number" min={caps.temperature.min} max={caps.temperature.max} step={caps.temperature.step} value={f.target} onChange={(e) => set("target", +e.target.value)} /></label>}
                  {caps?.fan && <label className="f">Ventilação<select value={f.fan} onChange={(e) => set("fan", e.target.value)}><option value="">(manter)</option>{caps.fan.values.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>}
                </div>
              </fieldset>
              {f.power && <fieldset><legend>3 · Até</legend>
                <div className="grid2">
                  <label className="f">Temperatura ≤ (°C)<input type="number" step="0.5" value={f.offTemp} onChange={(e) => set("offTemp", +e.target.value)} /></label>
                  <label className="f">por pelo menos (min)<input type="number" min={0} value={f.offFor} onChange={(e) => set("offFor", +e.target.value)} /></label>
                </div>
                <label className="f inline"><input type="checkbox" checked={f.turnOff} onChange={(e) => set("turnOff", e.target.checked)} /> Desligar ao chegar lá</label>
              </fieldset>}
              <details><summary>Limites de segurança e prioridade</summary>
                <div className="grid2">
                  <label className="f">Tempo máximo ligado (h)<input type="number" min={1} max={12} value={f.maxH} onChange={(e) => set("maxH", +e.target.value)} /></label>
                  <label className="f">Espera após executar (min)<input type="number" min={0} value={f.cooldownMin} onChange={(e) => set("cooldownMin", +e.target.value)} /></label>
                  <label className="f">Mín. ligado (min, ≥3)<input type="number" min={3} value={f.minOnMin} onChange={(e) => set("minOnMin", +e.target.value)} /></label>
                  <label className="f">Mín. desligado (min, ≥3)<input type="number" min={3} value={f.minOffMin} onChange={(e) => set("minOffMin", +e.target.value)} /></label>
                  <label className="f">Máx. comandos/hora<input type="number" min={1} max={20} value={f.maxCmdH} onChange={(e) => set("maxCmdH", +e.target.value)} /></label>
                  <label className="f">Prioridade (0–100)<input type="number" min={0} max={100} value={f.priority} onChange={(e) => set("priority", +e.target.value)} /></label>
                </div>
              </details>
            </section>
            <section className="card" aria-live="polite">
              <header><div><h3>Como vai funcionar</h3><p>Resumo da regra, validado pelo servidor.</p></div></header>
              {preview && <div className="preview stack" style={{ gap: ".25rem" }}><Lines d={preview} /></div>}
              {errors.length > 0 ? <ul role="alert" className="err small" style={{ margin: 0, paddingLeft: "1.1rem" }}>{errors.map((e) => <li key={e}>{e}</li>)}</ul> : preview && <p className="ok-text small" style={{ margin: 0 }}>Regra segura. Pode salvar.</p>}
              <div><button type="submit" className="btn primary" disabled={errors.length > 0}>Salvar automação</button></div>
            </section>
          </form>
        )}
      </div>
    </>
  );
}
