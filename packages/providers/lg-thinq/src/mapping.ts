import type { AttributePatch, Capabilities, Fan, Mode, NormalizedState, StateField } from "@acc/domain";
import { STATE_FIELDS } from "@acc/domain";

const MODE_FROM_LG: Record<string, Mode> = { COOL: "cool", HEAT: "heat", AIR_DRY: "dry", FAN: "fan", AUTO: "auto" };
const MODE_TO_LG: Record<Mode, string> = { cool: "COOL", heat: "HEAT", dry: "AIR_DRY", fan: "FAN", auto: "AUTO" };

/** O que o perfil do aparelho real permite; derivado do device profile (nunca assumido). */
export interface LgProfile {
  caps: Omit<Capabilities, "energy">;
  fanKey?: "windStrength" | "windStrengthDetail";
  tempKey: "targetTemperature" | "coolTargetTemperature";
  swing: { v: boolean; h: boolean };
  hasPowerSave: boolean;
  hasDisplay: boolean; // display.light gravável (ON/OFF)
  modeValues: string[]; // valores LG graváveis de currentJobMode
}

const lower = (s: string) => s.toLowerCase();
const writable = (n: any) => !!n && (!Array.isArray(n.mode) || n.mode.includes("w"));
const wValues = (n: any): string[] => (n?.value?.w ?? n?.value?.r ?? []) as string[];

/** Procura um nó de faixa (min/max/step) para temperatura, tolerando variações de formato entre modelos. */
function findRange(node: any): { min: number; max: number; step: number } | undefined {
  const v = node?.value?.w ?? node?.value?.r;
  if (v && typeof v.min === "number" && typeof v.max === "number") return { min: v.min, max: v.max, step: v.step ?? 1 };
  return undefined;
}

export function parseProfile(raw: any): LgProfile {
  const p = raw?.property ?? raw ?? {};
  const op = p.operation?.airConOperationMode;
  const job = p.airConJobMode?.currentJobMode;
  const temp = p.temperature ?? {};
  const tempKey: LgProfile["tempKey"] = writable(temp.targetTemperature) ? "targetTemperature" : "coolTargetTemperature";
  let range = findRange(temp[tempKey]);
  if (!range && Array.isArray(p.temperatureInUnits)) { // alguns perfis trazem lista por unidade
    const c = p.temperatureInUnits.find((u: any) => u?.unit === "C" || u?.C);
    range = findRange(c?.[tempKey] ?? c?.C?.[tempKey]);
  }
  const modeValues = wValues(job);
  const modes = [...new Set(modeValues.map((m) => MODE_FROM_LG[m]).filter((m): m is Mode => !!m))];
  const airFlow = p.airFlow ?? {};
  // prefere windStrength (tem AUTO); o SDK oficial prefere windStrengthDetail e perde AUTO (issue #43)
  const fanKey = airFlow.windStrength ? "windStrength" : airFlow.windStrengthDetail ? "windStrengthDetail" : undefined;
  const wd = p.windDirection ?? {};
  const swing = { v: writable(wd.rotateUpDown), h: writable(wd.rotateLeftRight) };
  const hasPowerSave = writable(p.powerSave?.powerSaveEnabled);
  const hasDisplay = writable(p.display?.light);
  const caps: LgProfile["caps"] = {
    power: !!op && (wValues(op).length === 0 || wValues(op).includes("POWER_ON")) && writable(op),
    temperature: range, modes,
    fan: fanKey ? { values: wValues(airFlow[fanKey]).map(lower) } : undefined,
    swing: swing.v || swing.h ? { vertical: swing.v, horizontal: swing.h } : undefined,
    powerSave: hasPowerSave, display: hasDisplay, humiditySensor: !!p.airQualitySensor?.humidity,
  };
  return { caps, fanKey, tempKey, swing, hasPowerSave, hasDisplay, modeValues };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Converte estado completo OU delta de evento (`report`) em estado normalizado só com os campos presentes. */
export function parseState(raw: any, profile?: LgProfile): { state: NormalizedState; fieldsPresent: StateField[] } {
  const s: NormalizedState = {};
  const power = raw?.operation?.airConOperationMode;
  if (power === "POWER_ON") s.power = true; else if (power === "POWER_OFF") s.power = false;
  const mode = raw?.airConJobMode?.currentJobMode;
  if (typeof mode === "string" && MODE_FROM_LG[mode]) s.mode = MODE_FROM_LG[mode];
  const t = raw?.temperature;
  if (t) {
    const unit = t.unit ?? "C";
    const conv = (v: unknown) => { const n = num(v); return n === undefined ? undefined : unit === "F" ? Math.round(((n - 32) * 5) / 9 * 2) / 2 : n; };
    const cur = conv(t.currentTemperature); if (cur !== undefined) s.currentTemp = cur;
    const tgt = conv(t[profile?.tempKey ?? "targetTemperature"] ?? t.targetTemperature ?? t.coolTargetTemperature); if (tgt !== undefined) s.targetTemp = tgt;
  }
  const fan = raw?.airFlow?.[profile?.fanKey ?? "windStrength"] ?? raw?.airFlow?.windStrength ?? raw?.airFlow?.windStrengthDetail;
  if (typeof fan === "string") s.fan = lower(fan) as Fan;
  const light = raw?.display?.light;
  if (light === "ON") s.display = true; else if (light === "OFF") s.display = false;
  const hum = num(raw?.airQualitySensor?.humidity); if (hum !== undefined) s.humidity = hum;
  return { state: s, fieldsPresent: STATE_FIELDS.filter((f) => s[f] !== undefined) };
}

/** Um corpo por grupo, na ordem: power primeiro (o aparelho precisa estar ligado para aceitar o resto). */
export function buildCommands(patch: AttributePatch, profile: LgProfile): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (patch.power !== undefined) out.push({ operation: { airConOperationMode: patch.power ? "POWER_ON" : "POWER_OFF" } });
  if (patch.mode !== undefined) out.push({ airConJobMode: { currentJobMode: MODE_TO_LG[patch.mode] } });
  if (patch.targetTemp !== undefined) out.push({ temperature: { [profile.tempKey]: patch.targetTemp, unit: "C" } });
  if (patch.fan !== undefined && profile.fanKey) out.push({ airFlow: { [profile.fanKey]: patch.fan.toUpperCase() } });
  if (patch.swingV !== undefined) out.push({ windDirection: { rotateUpDown: patch.swingV } });
  if (patch.swingH !== undefined) out.push({ windDirection: { rotateLeftRight: patch.swingH } });
  if (patch.powerSave !== undefined) out.push({ powerSave: { powerSaveEnabled: patch.powerSave } });
  if (patch.display !== undefined) out.push({ display: { light: patch.display ? "ON" : "OFF" } });
  return out;
}

/** Validação local contra o perfil real (como o SDK oficial): evita gastar chamada/rate limit com comando que a LG rejeitaria (2207). */
export function checkPatch(patch: AttributePatch, p: LgProfile): string | null {
  const t = p.caps.temperature;
  if (patch.targetTemp !== undefined) {
    if (!t) return "aparelho não permite definir temperatura";
    const steps = (patch.targetTemp - t.min) / t.step;
    if (patch.targetTemp < t.min || patch.targetTemp > t.max || Math.abs(steps - Math.round(steps)) > 1e-6) return `temperatura ${patch.targetTemp} fora de ${t.min}-${t.max} (passo ${t.step})`;
  }
  if (patch.mode !== undefined && !p.caps.modes.includes(patch.mode)) return `modo ${patch.mode} não suportado`;
  if (patch.fan !== undefined && !p.caps.fan?.values.includes(patch.fan)) return `fan ${patch.fan} não suportado`;
  if (patch.swingV !== undefined && !p.swing.v) return "swing vertical não suportado";
  if (patch.swingH !== undefined && !p.swing.h) return "swing horizontal não suportado";
  if (patch.powerSave !== undefined && !p.hasPowerSave) return "power-save não suportado";
  if (patch.display !== undefined && !p.hasDisplay) return "visor não suportado";
  return null;
}
