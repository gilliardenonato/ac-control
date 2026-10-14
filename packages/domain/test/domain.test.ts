import { describe, expect, it } from "vitest";
import { DEFAULT_GUARDS, emptyState, inTimeWindow, mergeState, StateStore, validateRule, RuleDefinition } from "../src/index.ts";

describe("mergeState", () => {
  it("só campos presentes substituem; ausente mantém", () => {
    let s = mergeState(emptyState(), { power: true, currentTemp: 28, targetTemp: 23 }, ["power", "currentTemp", "targetTemp"], 1000);
    s = mergeState(s, { power: false }, ["power"], 2000);
    expect(s.values).toMatchObject({ power: false, currentTemp: 28, targetTemp: 23 });
    expect(s.observedAt.power).toBe(2000);
    expect(s.observedAt.currentTemp).toBe(1000);
  });
  it("campo declarado mas undefined não apaga", () => {
    const s = mergeState({ values: { currentTemp: 25 }, observedAt: { currentTemp: 1 } }, {}, ["currentTemp"], 5);
    expect(s.values.currentTemp).toBe(25);
  });
});

describe("inTimeWindow", () => {
  const at = (iso: string) => Date.parse(iso);
  const tz = "America/Sao_Paulo"; // UTC-3
  it("janela noturna atravessa meia-noite", () => {
    expect(inTimeWindow(at("2026-01-10T23:30:00-03:00"), "20:00", "06:00", tz)).toBe(true);
    expect(inTimeWindow(at("2026-01-10T03:00:00-03:00"), "20:00", "06:00", tz)).toBe(true);
    expect(inTimeWindow(at("2026-01-10T12:00:00-03:00"), "20:00", "06:00", tz)).toBe(false);
    expect(inTimeWindow(at("2026-01-10T06:00:00-03:00"), "20:00", "06:00", tz)).toBe(false);
  });
});

const base: RuleDefinition = {
  name: "noite", deviceId: "d1", enabled: true, priority: 50,
  when: { type: "all", of: [{ type: "temp", op: ">=", value: 27, forSec: 600 }] },
  actions: [{ type: "setAttributes", power: true, mode: "cool", targetTemp: 23 }],
  until: { type: "temp", op: "<=", value: 24 },
  onEnd: [{ type: "setAttributes", power: false }],
  guards: DEFAULT_GUARDS,
};
describe("validateRule", () => {
  it("aceita regra segura", () => expect(validateRule(base)).toEqual([]));
  it("exige until/onEnd quando liga", () => {
    const r = { ...base, until: undefined, onEnd: undefined };
    expect(validateRule(r).join()).toMatch(/until.*onEnd|onEnd/);
  });
  it("recusa histerese < 1 °C", () => {
    const r = { ...base, until: { type: "temp", op: "<=", value: 26.5 } as const };
    expect(validateRule(r).join()).toMatch(/histerese/);
  });
  it("recusa maxRuntime acima do teto e minOn baixo", () => {
    const r = { ...base, guards: { ...DEFAULT_GUARDS, maxRuntimeSec: 99 * 3600, minOnSec: 5 } };
    expect(validateRule(r).length).toBe(2);
  });
});

describe("StateStore", () => {
  const ev = (power: boolean, at: number) => ({ deviceId: "d", receivedAt: at, fieldsPresent: ["power" as const], normalizedState: { power } });
  it("primeira observação não define powerSince; transição define", () => {
    const s = new StateStore();
    s.apply(ev(false, 100)); expect(s.powerSince("d")).toBeUndefined();
    s.apply(ev(false, 200)); expect(s.powerSince("d")).toBeUndefined();
    const r = s.apply(ev(true, 300)); expect(r.powerChanged).toBe(true); expect(s.powerSince("d")).toBe(300);
  });
});
