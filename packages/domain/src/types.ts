// Tipos do domínio. Nada aqui conhece LG.
export type Mode = "cool" | "heat" | "auto" | "fan" | "dry";
export type Fan = string; // valores vêm das capabilities do aparelho (ex.: auto, low, mid, high)

export interface NormalizedState {
  power?: boolean;
  mode?: Mode;
  targetTemp?: number;
  currentTemp?: number;
  fan?: Fan;
  humidity?: number;
  display?: boolean; // visor (luz) do aparelho aceso
  online?: boolean;
}
export type StateField = keyof NormalizedState;
export const STATE_FIELDS: StateField[] = ["power", "mode", "targetTemp", "currentTemp", "fan", "humidity", "display", "online"];

/** Estado mesclado por campo; cada campo guarda quando foi observado. */
export interface DeviceState {
  values: NormalizedState;
  observedAt: Partial<Record<StateField, number>>;
}

export interface Capabilities {
  power: boolean;
  temperature?: { min: number; max: number; step: number };
  modes: Mode[];
  fan?: { values: Fan[] };
  swing?: { vertical: boolean; horizontal: boolean };
  powerSave: boolean;
  display: boolean; // dá para acender/apagar o visor
  humiditySensor: boolean;
  energy: EnergyCapabilities;
}
export interface EnergyCapabilities {
  supported: boolean;
  granularities: ("hour" | "day" | "month")[];
  unit: "Wh";
  properties: string[];
}

export type AttributePatch = Partial<{
  power: boolean; mode: Mode; targetTemp: number; fan: Fan; swingV: boolean; swingH: boolean; powerSave: boolean; display: boolean;
}>;

export type EventSource = "mqtt" | "poll" | "command-echo";
export interface DeviceEvent {
  type: "state";
  deviceId: string; // id interno do domínio
  receivedAt: number;
  source: EventSource;
  fieldsPresent: StateField[];
  normalizedState: NormalizedState; // só os campos presentes
  providerTimestamp?: number;
}
export interface ProviderHealth {
  type: "health";
  status: "connected" | "degraded" | "disconnected";
  at: number;
  reason?: string;
}

export type ProviderErrorKind =
  | "offline" | "notSupportedInState" | "notSupportedInMode" | "invalidCommand" | "rateLimited"
  | "auth" | "scope" | "transient" | "unsupported" | "fatal";
export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, message: string, public opts: { retryable?: boolean; retryAfterMs?: number; code?: string } = {}) {
    super(message);
  }
  get retryable() { return this.opts.retryable ?? (this.kind === "transient" || this.kind === "rateLimited"); }
  get code() { return this.opts.code; }
}

/** `key` é a data LOCAL do usuário como a LG informa: "YYYY-MM-DD" (day), "YYYY-MM" (month), "YYYY-MM-DDTHH" (hour). */
export interface EnergyPoint { key: string; granularity: "hour" | "day" | "month"; wh: number; collectedAt: number }
/** `from`/`to` inclusivos, no formato do `granularity` (YYYY-MM-DD para day, YYYY-MM para month). */
export interface EnergyQuery { from: string; to: string; granularity: "day" | "month" }

/** Todo valor derivado carrega a origem: medido pela LG ou estimado por nós. */
export type Basis = "measured" | "estimated";
export interface Measure<T = number> { value: T; basis: Basis; source: string; at: number }

export type Origin = "manual" | "external" | "system" | `automation:${string}`;

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };
