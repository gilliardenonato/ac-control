export const brl = (v: number | null | undefined) => v === null || v === undefined ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const kwh = (wh: number | null | undefined) => wh === null || wh === undefined ? "—" : `${(wh / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} kWh`;
export const dur = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`; };
export const durSec = (s: number) => dur(s / 60);
export const time = (ms: number) => new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const ago = (ms: number | undefined, now = Date.now()) => { if (ms === undefined) return "nunca"; const m = Math.round((now - ms) / 60000); return m < 1 ? "agora" : m < 60 ? `${m} min atrás` : `${Math.round(m / 60)} h atrás`; };
export const MODE_LABEL: Record<string, string> = { cool: "Frio", heat: "Quente", auto: "Auto", fan: "Ventilar", dry: "Seco" };
export const STATE_LABEL: Record<string, string> = { IDLE: "Aguardando", ARMED: "Armada", RUNNING: "Executando", COOLDOWN: "Em espera", SUSPENDED: "Suspensa" };

export const num1 = (v: number, d = 1) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
export const kwhN = (wh: number | null | undefined, d = 1) => (wh === null || wh === undefined ? "—" : num1(wh / 1000, d));
export const WEEKDAY = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export const MONTH = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
export const wdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
export const dm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
/** Variação percentual com texto e tom (aumento = "up"; ±2% = estável). */
export const pctDelta = (now: number, base: number, vs: string): { text: string; tone: "up" | "down" | "flat" } | null => {
  if (!(base > 0)) return null;
  const p = ((now - base) / base) * 100;
  return { text: `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(0)}% ${vs}`, tone: p > 2 ? "up" : p < -2 ? "down" : "flat" };
};
