export class ApiError extends Error {
  constructor(public status: number, public title: string, public errors?: string[], public detail?: string) { super(title); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1${path}`, {
    method, credentials: "same-origin",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-requested-with": "acc" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 204) return undefined as T;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.title ?? `Erro ${r.status}`, j.errors, j.detail);
  return j as T;
}
export const api = {
  get: <T,>(p: string) => req<T>("GET", p),
  post: <T,>(p: string, b?: unknown) => req<T>("POST", p, b ?? {}),
  put: <T,>(p: string, b: unknown) => req<T>("PUT", p, b),
  del: (p: string) => req<void>("DELETE", p),
};

export interface Caps { power: boolean; temperature?: { min: number; max: number; step: number }; modes: string[]; fan?: { values: string[] }; energy: { supported: boolean } }
export interface Device { id: string; name: string; model: string | null; state: { power?: boolean; mode?: string; targetTemp?: number; currentTemp?: number; fan?: string; humidity?: number; online?: boolean }; observedAt: Record<string, number>; capabilities: Caps | null; breaker: { reason: string; at: number } | null }
export interface AutomationState { ruleId: string; name: string; enabled: boolean; priority: number; state: string; since: number | null; untilTs: number | null; reason: string | null; runStartedAt: number | null; description: { when: string; then: string; until: string | null; onEnd: string | null } }
export interface Money { wh: number | null; costBrl: number | null; basis: "measured" | "estimated" | null; provisional?: boolean; daysWithData?: number }
export interface Dashboard {
  onTodayMinutes: number; onTodaySince: number | null; energy: { supported: boolean | null; lastSyncAt: number | null; lastError: string | null; needsScope: boolean };
  today: Money; month: Money; projection: null | { projectedCostBrl: number | null; projectedWh: number | null; lowCostMicro: number | null; highCostMicro: number | null; sampleDays: number; goalBrl: number | null; diffToGoalMicro: number | null; previousMonthWh: number | null; previousMonthCostMicro: number | null; avgDailyWh: number | null };
  automations: AutomationState[]; breaker: { reason: string; at: number } | null; tariffConfigured: boolean; estimateAvgWatts: number | null;
}

export interface Sensor { id: string; name: string; pollUrl: string; lastError: string | null; deviceId: string | null; lastSeenAt: number | null; temperature: number | null; humidity: number | null; online: boolean }
export type StreamEvent = { type: string; [k: string]: any };
export function openStream(onEvent: (e: StreamEvent) => void, onStatus: (ok: boolean) => void): () => void {
  const es = new EventSource("/api/v1/events/stream");
  const types = ["device.state", "command.status", "provider.health", "device.external-change", "session.opened", "session.closed", "automation.state", "breaker.open", "energy.updated", "sensor.reading"];
  for (const t of types) es.addEventListener(t, (m) => onEvent(JSON.parse((m as MessageEvent).data) as StreamEvent));
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  return () => es.close();
}
