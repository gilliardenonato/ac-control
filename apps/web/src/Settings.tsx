import { useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";
import type { Device, Sensor } from "./api.ts";
import { ago } from "./fmt.ts";
import { brl } from "./fmt.ts";
import { Badge } from "./ui.tsx";

const today = () => new Intl.DateTimeFormat("en-CA").format(Date.now());
export function Settings({ device, onLogout, onToast }: { device: Device; onLogout: () => void; onToast: (m: string) => void }) {
  const [price, setPrice] = useState(""); const [from, setFrom] = useState(today());
  const [hist, setHist] = useState<{ validFrom: string; pricePerKwh: number; note: string | null }[]>([]);
  const [goal, setGoal] = useState(""); const [watts, setWatts] = useState("");
  const [sensors, setSensors] = useState<Sensor[]>([]);
  const [sname, setSname] = useState("ESP32 Sala");
  const [surl, setSurl] = useState("http://192.168.1.14/sensor");
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const loadSensors = () => void api.get<Sensor[]>("/sensors").then(setSensors);
  useEffect(loadSensors, []);
  const month = today().slice(0, 7);
  const load = () => {
    void api.get<{ current: { pricePerKwh: number } | null; history: typeof hist }>("/tariff").then((t) => { setHist(t.history); if (t.current) setPrice(String(t.current.pricePerKwh).replace(".", ",")); });
    void api.get<{ budgetBrl: number | null }>(`/goals/${month}`).then((g) => setGoal(g.budgetBrl === null ? "" : String(g.budgetBrl)));
    void api.get<{ avgWatts: number | null }>("/settings/estimate").then((e) => setWatts(e.avgWatts === null ? "" : String(e.avgWatts)));
  };
  useEffect(load, [month]);
  const num = (s: string) => Number(s.replace(",", "."));
  return (
    <>
      <div className="pagehead"><h1>Configurações</h1></div>
      <div className="g12" style={{ alignItems: "start" }}>
        <section className="card c4">
          <header><div><h3>Tarifa de energia</h3><p>Preço do kWh usado para calcular custos.</p></div></header>
          <form className="form" onSubmit={async (e) => { e.preventDefault(); await api.put("/tariff", { validFrom: from, pricePerKwh: num(price) }); onToast("Tarifa salva"); load(); }}>
            <div className="grid2">
              <label className="f">R$ por kWh<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1,24" required /></label>
              <label className="f">Vale a partir de<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
            </div>
            <button className="btn primary" type="submit">Salvar tarifa</button>
          </form>
          <p className="muted small" style={{ margin: 0 }}>Cada dia usa a tarifa vigente nele; trocar a tarifa não muda o custo dos dias anteriores. Use o valor com impostos (ICMS/PIS/COFINS) da sua fatura.</p>
          {hist.length > 0 && <ul className="small muted" style={{ margin: 0, paddingLeft: "1.1rem" }}>{hist.map((h) => <li key={h.validFrom}>{h.validFrom}: <strong>{brl(h.pricePerKwh)}</strong>/kWh{h.note ? ` — ${h.note}` : ""}</li>)}</ul>}
        </section>
        <section className="card c4">
          <header><div><h3>Meta do mês ({month})</h3><p>Orçamento para comparar com a projeção.</p></div></header>
          <form className="form" onSubmit={async (e) => { e.preventDefault(); await api.put(`/goals/${month}`, { budgetBrl: num(goal) }); onToast("Meta salva"); }}>
            <label className="f">Orçamento (R$)<input inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="300" required /></label>
            <button className="btn primary" type="submit">Salvar meta</button>
          </form>
        </section>
        <section className="card c4">
          <header><div><h3>Consumo estimado (opcional)</h3></div></header>
          <p className="muted small" style={{ margin: 0 }}>Só é usado se o aparelho <strong>não</strong> informar consumo; aparece sempre como <Badge basis="estimated" />. Compressor inverter não consome a potência nominal o tempo todo: use uma média observada.</p>
          <form className="form" onSubmit={async (e) => { e.preventDefault(); await api.put("/settings/estimate", { avgWatts: watts ? num(watts) : null }); onToast("Salvo"); }}>
            <label className="f">Potência média quando ligado (W)<input inputMode="decimal" value={watts} onChange={(e) => setWatts(e.target.value)} placeholder="ex.: 600" /></label>
            <button className="btn" type="submit">Salvar</button>
          </form>
        </section>
        <section className="card c12" aria-label="Sensores externos">
          <header><div><h3>Sensores externos (ESP32)</h3><p>O AC Control consulta a URL do sensor a cada 30 s (resposta JSON com <span className="mono">temperature_c</span> e <span className="mono">humidity_pct</span>). As automações podem usar a temperatura do sensor no lugar da temperatura do ar.</p></div></header>
          {sensors.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nenhum sensor cadastrado.</p> : (
            <div className="scrollx"><table><thead><tr><th>Sensor</th><th>URL</th><th>Temperatura</th><th>Umidade</th><th>Última leitura</th><th>Estado</th><th /></tr></thead>
              <tbody>{sensors.map((x) => (
                <tr key={x.id}><td><strong>{x.name}</strong></td><td className="mono">{x.pollUrl}</td><td>{x.temperature !== null ? `${x.temperature.toFixed(1).replace(".", ",")} °C` : "—"}</td><td>{x.humidity !== null ? `${Math.round(x.humidity)}%` : "—"}</td><td>{ago(x.lastSeenAt ?? undefined)}</td>
                  <td><span className={`pill ${x.online ? "ok" : "warn"}`} title={x.lastError ?? ""}>{x.online ? "online" : "sem dados"}</span>{x.lastError && <div className="muted small">{x.lastError}</div>}</td>
                  <td><div className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="btn sm danger" onClick={async () => { if (!confirm(`Excluir “${x.name}”?`)) return; try { await api.del(`/sensors/${x.id}`); loadSensors(); } catch (e) { onToast(e instanceof ApiError ? e.title : "erro"); } }}>Excluir</button></div></td></tr>))}</tbody></table></div>)}
          <form className="stack" style={{ maxWidth: 620 }} onSubmit={async (e) => { e.preventDefault(); try { await api.post("/sensors", { name: sname, pollUrl: surl, deviceId: device.id }); setTest(null); onToast("Sensor cadastrado"); loadSensors(); } catch (x) { setTest({ ok: false, text: x instanceof ApiError ? x.title : "erro" }); } }}>
            <div className="grid2" style={{ gridTemplateColumns: "minmax(140px, 1fr) minmax(220px, 2fr)" }}>
              <label className="f">Nome<input value={sname} onChange={(e) => setSname(e.target.value)} required maxLength={60} /></label>
              <label className="f">URL do sensor<input value={surl} onChange={(e) => setSurl(e.target.value)} required placeholder="http://192.168.1.14/sensor" inputMode="url" /></label>
            </div>
            <div className="row">
              <button type="button" className="btn" onClick={async () => { setTest({ ok: true, text: "consultando…" }); const r = await api.post<{ ok: boolean; reading?: { temperature?: number; humidity?: number }; error?: string }>("/sensors/test", { pollUrl: surl }).catch(() => ({ ok: false as const, error: "URL inválida", reading: undefined })); setTest(r.ok ? { ok: true, text: `Leitura: ${r.reading?.temperature !== undefined ? `${r.reading.temperature.toFixed(1).replace(".", ",")} °C` : "—"} · umidade ${r.reading?.humidity !== undefined ? `${Math.round(r.reading.humidity)}%` : "—"}` } : { ok: false, text: r.error ?? "falhou" }); }}>Testar URL</button>
              <button type="submit" className="btn primary">Cadastrar sensor</button>
              {test && <span className={`small ${test.ok ? "ok-text" : "err"}`} role="status">{test.text}</span>}
            </div>
          </form>
        </section>
        <section className="card c4">
          <header><div><h3>Aparelho e sessão</h3></div></header>
          <p className="small" style={{ margin: 0 }}>{device.name}{device.model ? <span className="muted mono"> · {device.model}</span> : null}</p>
          <div><button className="btn" onClick={onLogout}>Sair</button></div>
        </section>
      </div>
    </>
  );
}
