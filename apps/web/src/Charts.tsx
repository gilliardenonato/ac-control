import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** Largura real do contêiner (os gráficos são desenhados em pixels, sem distorção). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.floor(el.getBoundingClientRect().width)));
    ro.observe(el); setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Escala "bonita": 0..max com ~4 divisões em passos 1/2/2.5/5 × 10^n. */
export function niceScale(max: number, ticks = 4): { max: number; step: number; values: number[] } {
  if (!(max > 0)) return { max: 1, step: 0.25, values: [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / ticks, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const values: number[] = []; for (let v = 0; v <= top + step / 1000; v += step) values.push(+v.toFixed(6));
  return { max: top, step, values };
}

export interface Tip { title: string; rows: [string, string][] }
const TipBox = ({ tip, left, width }: { tip: Tip; left: number; width: number }) => (
  <div className="tip" style={{ left: Math.min(Math.max(0, left - 80), Math.max(0, width - 170)), top: 0 }} role="tooltip">
    <div className="t">{tip.title}</div>{tip.rows.map(([a, b]) => <div className="r" key={a}><span>{a}</span><b>{b}</b></div>)}
  </div>
);

export interface BarItem { key: string; x: string; value: number; partial?: boolean; tip: Tip }
export function BarChart({ items, height = 280, yFormat, avg, ariaLabel }: { items: BarItem[]; height?: number; yFormat: (v: number) => string; avg?: { value: number; label: string }; ariaLabel: string }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const L = 48, R = avg ? 70 : 8, T = 10, B = 26; // margem à direita reserva o rótulo da média
  const iw = Math.max(10, w - L - R), ih = height - T - B;
  const max = Math.max(...items.map((i) => i.value), avg?.value ?? 0, 0.0001);
  const sc = niceScale(max * 1.04);
  const gap = items.length > 60 ? 1 : items.length > 30 ? 2 : 4;
  const bw = Math.max(2, (iw - gap * (items.length - 1)) / Math.max(1, items.length));
  const Y = (v: number) => T + ih - (v / sc.max) * ih;
  const every = Math.max(1, Math.ceil(items.length / Math.max(2, Math.floor(iw / 64))));
  return (
    <div className="chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
          {sc.values.map((v) => <g key={v}><line className="grid" x1={L} x2={w - R} y1={Y(v)} y2={Y(v)} /><text className="axis-text" x={L - 8} y={Y(v) + 4} textAnchor="end">{yFormat(v)}</text></g>)}
          {items.map((it, i) => {
            const x = L + i * (bw + gap), h = Math.max(1, (it.value / sc.max) * ih);
            return (
              <g key={it.key}>
                <rect className={`bar ${it.partial ? "partial" : ""} ${hover !== null && hover !== i ? "dim" : ""}`} x={x} y={Y(it.value)} width={bw} height={h} rx={Math.min(3, bw / 3)} />
                <rect x={x - gap / 2} y={T} width={bw + gap} height={ih + B} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} />
                {i % every === 0 && <text className="axis-text" x={x + bw / 2} y={height - 8} textAnchor="middle">{it.x}</text>}
              </g>
            );
          })}
          {avg && <g><line className="avg" x1={L} x2={w - R + 6} y1={Y(avg.value)} y2={Y(avg.value)} /><text className="avg-text" x={w - R + 10} y={Y(avg.value) + 4} textAnchor="start">{avg.label}</text></g>}
        </svg>
      )}
      {hover !== null && items[hover] && w > 0 && <TipBox tip={items[hover]!.tip} left={L + hover * (bw + gap) + bw / 2} width={w} />}
    </div>
  );
}

export interface Series { id: string; name: string; cls: "a" | "b" | "c"; dashed?: boolean; points: { x: number; y: number }[]; area?: boolean }
export function LineChart({ series, xDomain, xTicks, xFormat, yFormat, height = 260, bands = [], hlines = [], yDomain, tip, ariaLabel }: {
  series: Series[]; xDomain: [number, number]; xTicks: number[]; xFormat: (x: number) => string; yFormat: (v: number) => string; height?: number;
  bands?: { from: number; to: number }[]; hlines?: { y: number; label: string }[]; yDomain?: [number, number]; tip?: (x: number, vals: { s: Series; y: number | null }[]) => Tip; ariaLabel: string;
}) {
  const [ref, w] = useWidth();
  const [hx, setHx] = useState<number | null>(null);
  const L = 48, R = 12, T = 10, B = 26;
  const iw = Math.max(10, w - L - R), ih = height - T - B;
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).concat(hlines.map((h) => h.y));
  let y0 = yDomain?.[0] ?? Math.min(...ys, 0), y1 = yDomain?.[1] ?? Math.max(...ys, 1);
  if (yDomain === undefined && y0 > 0) y0 = 0;
  const sc = niceScale(y1 - y0 || 1); const lo = yDomain ? y0 : 0, hi = yDomain ? y1 : sc.max; const span = hi - lo || 1;
  const X = (x: number) => L + ((x - xDomain[0]) / Math.max(1, xDomain[1] - xDomain[0])) * iw;
  const Y = (v: number) => T + ih - ((v - lo) / span) * ih;
  const yTicks = yDomain ? Array.from({ length: 5 }, (_, i) => lo + (span * i) / 4) : sc.values;
  const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const nearest = (s: Series, x: number) => s.points.reduce<{ x: number; y: number } | null>((b, p) => (!b || Math.abs(p.x - x) < Math.abs(b.x - x) ? p : b), null);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(); const px = e.clientX - r.left;
    if (px < L || px > w - R) return setHx(null);
    const xv = xDomain[0] + ((px - L) / iw) * (xDomain[1] - xDomain[0]);
    const first = series[0]; const p = first && nearest(first, xv); setHx(p ? p.x : null);
  };
  const vals = hx === null ? [] : series.map((s) => { const p = s.points.find((q) => q.x === hx) ?? null; return { s, y: p ? p.y : null }; });
  return (
    <div className="chart" ref={ref}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} onMouseMove={onMove} onMouseLeave={() => setHx(null)}>
          {yTicks.map((v) => <g key={v}><line className="grid" x1={L} x2={w - R} y1={Y(v)} y2={Y(v)} /><text className="axis-text" x={L - 8} y={Y(v) + 4} textAnchor="end">{yFormat(v)}</text></g>)}
          {bands.map((b, i) => <rect key={i} className="band" x={X(Math.max(b.from, xDomain[0]))} y={T} width={Math.max(1, X(Math.min(b.to, xDomain[1])) - X(Math.max(b.from, xDomain[0])))} height={ih} />)}
          {xTicks.map((t) => <text key={t} className="axis-text" x={X(t)} y={height - 8} textAnchor="middle">{xFormat(t)}</text>)}
          {hlines.map((h) => <g key={h.label}><line className="hl" x1={L} x2={w - R} y1={Y(h.y)} y2={Y(h.y)} /><text className="hl-text" x={w - R} y={Y(h.y) - 4} textAnchor="end">{h.label}</text></g>)}
          {series.map((s) => s.points.length > 0 && <g key={s.id}>{s.area && <path className="area" d={`${path(s.points)} L${X(s.points.at(-1)!.x)},${Y(lo)} L${X(s.points[0]!.x)},${Y(lo)} Z`} />}<path className={`line ${s.cls} ${s.dashed ? "dashed" : ""}`} d={path(s.points)} /></g>)}
          {hx !== null && <line className="cross" x1={X(hx)} x2={X(hx)} y1={T} y2={T + ih} />}
          {hx !== null && vals.map((v) => v.y !== null && <circle key={v.s.id} className={`pt`} cx={X(hx)} cy={Y(v.y)} r={4} fill={`var(--chart-${v.s.cls === "a" ? "a" : v.s.cls === "b" ? "b" : "c"})`} />)}
        </svg>
      )}
      {hx !== null && tip && w > 0 && <TipBox tip={tip(hx, vals)} left={X(hx)} width={w} />}
    </div>
  );
}

export const Legend = ({ items }: { items: { name: string; cls: string; dashed?: boolean }[] }) => (
  <div className="legend">{items.map((i) => <span key={i.name}><i className={i.dashed ? "dash" : ""} style={{ background: `var(--chart-${i.cls})`, color: `var(--chart-${i.cls})` }} />{i.name}</span>)}</div>
);
export type { ReactNode };
