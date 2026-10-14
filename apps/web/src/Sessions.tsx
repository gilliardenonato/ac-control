import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Device } from "./api.ts";
import { brl, durSec, kwh, MODE_LABEL, time } from "./fmt.ts";
import { Badge } from "./ui.tsx";

interface Sess { id: string; startTs: number; endTs: number | null; durationSec: number; open: boolean; tempStart: number | null; tempEnd: number | null; targetTemp: number | null; mode: string | null; origin: string | null; closedBy: string | null;
  estimate: { method: string; wh: number | null; costBrl: number | null; provisional: boolean; reason: string | null } }

export function Sessions({ device, tick }: { device: Device; tick: number }) {
  const [rows, setRows] = useState<Sess[]>([]);
  const [days, setDays] = useState(7);
  useEffect(() => { void api.get<Sess[]>(`/devices/${device.id}/sessions?from=${Date.now() - days * 86400_000}`).then((r) => setRows([...r].reverse())); }, [device.id, tick, days]);
  const origin = (o: string | null) => !o ? "—" : o.startsWith("automation:") ? "Automação" : ({ manual: "Manual", external: "App/controle", unknown: "Já estava ligado" } as Record<string, string>)[o] ?? o;
  const how = (m: string) => m === "snapshot_delta" ? "pela diferença do contador da LG (±10 min)" : m === "proportional" ? "dividindo o total do dia pelo tempo ligado" : "sem dados";
  return (
    <>
      <div className="pagehead"><h1>Sessões</h1><span className="sub">Cada vez que o aparelho liga e desliga.</span><span className="grow" />
        <div className="seg" role="group" aria-label="Período">{[1, 7, 30].map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d === 1 ? "24 h" : `${d} dias`}</button>)}</div></div>
      <section className="card">
        <header><div><h3>Sessões no período</h3><p>Consumo e custo por sessão são <Badge basis="estimated" /> — a LG informa o consumo por dia, não de cada sessão. Passe o mouse no consumo para ver como foi calculado.</p></div></header>
        {!rows.length ? <p className="muted">Nenhuma sessão no período.</p> : (
          <div className="scrollx"><table>
            <thead><tr><th>Início</th><th>Duração</th><th>Temp. ini → fim</th><th>Alvo</th><th>Modo</th><th>Origem</th><th>Consumo</th><th>Custo</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id}>
                <td>{time(s.startTs)}{s.open && <span className="pill ok" style={{ marginLeft: ".4rem" }}>agora</span>}</td><td>{durSec(s.durationSec)}</td>
                <td>{s.tempStart?.toFixed(1) ?? "—"} → {s.tempEnd?.toFixed(1) ?? "—"}</td><td>{s.targetTemp ?? "—"} °C</td><td>{s.mode ? MODE_LABEL[s.mode] ?? s.mode : "—"}</td><td>{origin(s.origin)}</td>
                <td title={s.estimate.wh === null ? (s.estimate.reason ?? "") : `Estimado ${how(s.estimate.method)}`}>{kwh(s.estimate.wh)}{s.estimate.provisional && s.estimate.wh !== null && " *"}</td><td>{brl(s.estimate.costBrl)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>* provisório: o dia ainda não fechou na LG.</p>
      </section>
    </>
  );
}
