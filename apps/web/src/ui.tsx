import type { ReactNode } from "react";

export type Basis = "measured" | "estimated" | null | undefined;
export const Badge = ({ basis }: { basis: Basis }) =>
  basis ? <span className={`badge ${basis}`} title={basis === "measured" ? "Informado pelo aparelho/LG" : "Calculado por nós; não é medição"}>{basis === "measured" ? "MEDIDO" : "ESTIMADO"}</span> : null;

export type Delta = { text: string; tone: "up" | "down" | "flat" } | null;
/** Variação com seta: aumento de consumo/custo em âmbar, queda em verde (sem julgar causa). */
export const DeltaText = ({ d }: { d: Delta }) => (d ? <span className={`delta ${d.tone}`}>{d.tone === "up" ? "▲" : d.tone === "down" ? "▼" : "•"} {d.text}</span> : null);

export function Kpi({ label, value, unit, detail, basis, delta, status }: { label: string; value: ReactNode; unit?: string; detail?: ReactNode; basis?: Basis; delta?: Delta; status?: "ok" | "warn" | "crit" }) {
  return (
    <div className="card kpi">
      <div className="top"><span className="label">{label}</span><span className="row" style={{ gap: ".4rem" }}><Badge basis={basis} />{status && <span className={`dot ${status}`} aria-hidden="true" />}</span></div>
      <div className="val"><span>{value}</span>{unit && <span className="unit">{unit}</span>}</div>
      <div className="detail">{delta && <><DeltaText d={delta} />{detail ? " · " : ""}</>}{detail}</div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled, label, full }: { value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; label: string; full?: boolean }) {
  return (
    <div className={`seg ${full ? "full" : ""}`} role="group" aria-label={label}>
      {options.map((o) => <button key={o.value} type="button" aria-pressed={value === o.value} disabled={disabled} onClick={() => value !== o.value && onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function Stepper({ value, min, max, step, unit, disabled, onChange, label }: { value: number; min: number; max: number; step: number; unit: string; disabled?: boolean; onChange: (v: number) => void; label: string }) {
  const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1)).replace(".", ",");
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label="Diminuir" disabled={disabled || value - step < min} onClick={() => onChange(value - step)}>−</button>
      <output aria-live="polite">{f(value)} {unit}</output>
      <button type="button" aria-label="Aumentar" disabled={disabled || value + step > max} onClick={() => onChange(value + step)}>+</button>
    </div>
  );
}

export const Alert = ({ kind, children }: { kind: "crit" | "warn" | "info"; children: ReactNode }) => <div className={`alert ${kind}`} role={kind === "info" ? undefined : "alert"}>{children}</div>;
export const Section = ({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) => <div className="sec"><h2>{title}</h2>{hint && <p>{hint}</p>}{children}</div>;
