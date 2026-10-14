import { AttributePatch } from "./types.ts";

export type Op = ">=" | "<=" | ">" | "<" | "==";
export type Condition =
  | { type: "temp"; op: Op; value: number; forSec?: number; sensor?: string } /* sensor: id de sensor externo; ausente = sensor do próprio aparelho */
  | { type: "timeWindow"; from: string; to: string; tz?: string }
  | { type: "weekday"; in: number[] } // 1=segunda … 7=domingo
  | { type: "deviceState"; power?: boolean; mode?: string }
  | { type: "onDuration"; op: Op; seconds: number }
  | { type: "all"; of: Condition[] }
  | { type: "any"; of: Condition[] }
  | { type: "not"; of: Condition };

export type Action =
  | ({ type: "setAttributes" } & AttributePatch)
  | { type: "wait"; sec: number }
  | { type: "runFor"; sec: number };

export interface Guards {
  maxRuntimeSec: number;
  cooldownSec: number;
  minOnSec: number;
  minOffSec: number;
  overrideSuspendSec: number;
  maxCommandsPerHour: number;
}
export interface RuleDefinition {
  name: string;
  deviceId: string;
  enabled: boolean;
  priority: number;
  when: Condition;
  actions: Action[];
  until?: Condition;
  onEnd?: Action[];
  guards: Guards;
}

export const GLOBAL_LIMITS = { maxRuntimeSec: 12 * 3600, minOnSec: 180, minOffSec: 180, minHysteresisC: 1, maxCommandsPerHour: 20 } as const;
export const DEFAULT_GUARDS: Guards = { maxRuntimeSec: 8 * 3600, cooldownSec: 1800, minOnSec: 600, minOffSec: 300, overrideSuspendSec: 3600, maxCommandsPerHour: 6 };

const walk = (c: Condition, f: (c: Condition) => void) => {
  f(c);
  if (c.type === "all" || c.type === "any") c.of.forEach((x) => walk(x, f));
  if (c.type === "not") walk(c.of, f);
};
const tempConds = (c: Condition | undefined) => { const r: Extract<Condition, { type: "temp" }>[] = []; if (c) walk(c, (x) => x.type === "temp" && r.push(x)); return r; };
const turnsOn = (a: Action[]) => a.some((x) => x.type === "setAttributes" && x.power === true);

/** Regras que ligam o aparelho precisam de saída, limite de tempo e histerese. Retorna lista de erros (vazia = ok). */
export function validateRule(r: RuleDefinition): string[] {
  const e: string[] = [];
  const g = r.guards;
  if (!(g.maxRuntimeSec > 0) || g.maxRuntimeSec > GLOBAL_LIMITS.maxRuntimeSec) e.push(`maxRuntimeSec deve estar entre 1 e ${GLOBAL_LIMITS.maxRuntimeSec}`);
  if (g.minOnSec < GLOBAL_LIMITS.minOnSec) e.push(`minOnSec mínimo é ${GLOBAL_LIMITS.minOnSec}`);
  if (g.minOffSec < GLOBAL_LIMITS.minOffSec) e.push(`minOffSec mínimo é ${GLOBAL_LIMITS.minOffSec}`);
  if (g.cooldownSec < 0) e.push("cooldownSec não pode ser negativo");
  if (!(g.maxCommandsPerHour > 0) || g.maxCommandsPerHour > GLOBAL_LIMITS.maxCommandsPerHour) e.push(`maxCommandsPerHour deve estar entre 1 e ${GLOBAL_LIMITS.maxCommandsPerHour}`);
  if (r.actions.length === 0) e.push("a regra precisa de ao menos uma ação");
  if (turnsOn(r.actions)) {
    if (!r.until) e.push("regra que liga o aparelho exige 'until'");
    if (!r.onEnd || r.onEnd.length === 0) e.push("regra que liga o aparelho exige 'onEnd' (ex.: desligar)");
    // histerese: entrada e saída por temperatura devem estar separadas
    const enter = tempConds(r.when), exit = tempConds(r.until);
    for (const en of enter) for (const ex of exit) {
      const up = en.op === ">=" || en.op === ">", dn = ex.op === "<=" || ex.op === "<";
      if (up && dn && en.value - ex.value < GLOBAL_LIMITS.minHysteresisC) e.push(`histerese insuficiente: entrada ${en.value} e saída ${ex.value} (mín. ${GLOBAL_LIMITS.minHysteresisC} °C)`);
      const dn2 = en.op === "<=" || en.op === "<", up2 = ex.op === ">=" || ex.op === ">";
      if (dn2 && up2 && ex.value - en.value < GLOBAL_LIMITS.minHysteresisC) e.push(`histerese insuficiente: entrada ${en.value} e saída ${ex.value} (mín. ${GLOBAL_LIMITS.minHysteresisC} °C)`);
    }
  }
  return e;
}
