import { describe, expect, it } from "vitest";
import { DEFAULT_GUARDS, ProviderError } from "@acc/domain";
import type { RuleDefinition } from "@acc/domain";
import { AutomationEngine } from "@acc/automation";
import { FakeProvider } from "@acc/provider-fake";
import { openDb, Store } from "@acc/storage";
import { createRuntime } from "../src/runtime.ts";

const TZ = "America/Sao_Paulo";
const T0 = Date.parse("2026-01-10T21:00:00-03:00");

async function setup(def: Partial<RuleDefinition> = {}, opts: { ambient?: number; start?: number } = {}) {
  let t = opts.start ?? T0;
  const clock = { now: () => t };
  const store = new Store(openDb(":memory:"));
  const provider = new FakeProvider({ clock, ambientC: opts.ambient ?? 29 });
  const rt = createRuntime({ store, provider, clock, tz: TZ, sleep: async () => {} });
  await rt.core.start();
  const dev = store.devices()[0]!;
  const rule: RuleDefinition = {
    name: "noite", deviceId: dev.id, enabled: true, priority: 50,
    when: { type: "all", of: [{ type: "temp", op: ">=", value: 27, forSec: 600 }, { type: "timeWindow", from: "20:00", to: "06:00" }] },
    actions: [{ type: "setAttributes", power: true, mode: "cool", targetTemp: 23, fan: "auto" }],
    until: { type: "temp", op: "<=", value: 24 },
    onEnd: [{ type: "setAttributes", power: false }],
    guards: DEFAULT_GUARDS, ...def,
  };
  const row = store.saveRule({ deviceId: dev.id, name: rule.name, enabled: rule.enabled, priority: rule.priority, definition: rule });
  const settle = async () => { await rt.engine.idle(); await rt.core.gateway.idle(); await rt.engine.idle(); };
  const advance = async (min: number, physics = true) => {
    for (let i = 0; i < min; i++) { t += 60_000; if (physics) provider.tick(); rt.engine.tick(); await settle(); }
  };
  const state = (id = row.id) => rt.engine.stateOf(id);
  return { ...rt, store, provider, dev, row, advance, settle, state, clock, setT: (x: number) => { t = x; }, now: () => t };
}

describe("AutomationEngine", () => {
  it("exemplo do produto: >=27 por 10 min, janela noturna → liga; ao chegar em 24 → desliga; sem oscilar", async () => {
    const s = await setup();
    await s.settle();
    await s.engine.tick(); await s.settle();
    expect(s.state()).toBe("ARMED");
    await s.advance(5); expect(s.provider.commands).toHaveLength(0);
    await s.advance(6);
    expect(s.provider.commands[0]).toEqual({ power: true, targetTemp: 23 }); // mode/fan já iguais ao estado: dedup
    expect(s.state()).toBe("RUNNING");
    await s.advance(45);
    expect(s.provider.commands).toHaveLength(2);
    expect(s.provider.commands[1]).toEqual({ power: false });
    expect(s.state()).toBe("COOLDOWN");
    const runs = s.store.ruleRuns(s.row.id);
    expect(runs[0]!.outcome).toBe("until");
  });

  it("fora da janela de horário não liga", async () => {
    const s = await setup({}, { start: Date.parse("2026-01-10T12:00:00-03:00") });
    await s.advance(30);
    expect(s.provider.commands).toHaveLength(0);
    expect(s.state()).toBe("IDLE");
  });

  it("debounce: pico mais curto que forSec não dispara", async () => {
    const s = await setup({}, { ambient: 25 });
    for (let i = 0; i < 6; i++) { s.provider.emitPartial({ currentTemp: 28 }); await s.advance(1, false); }
    s.provider.emitPartial({ currentTemp: 25 }); await s.advance(1, false);
    await s.advance(15, false);
    expect(s.provider.commands).toHaveLength(0);
    expect(s.state()).toBe("IDLE");
  });

  it("sensor velho vira 'desconhecido' e não dispara", async () => {
    const s = await setup({ when: { type: "temp", op: ">=", value: 27 } });
    s.setT(s.now() + 30 * 60_000); // única leitura (29 °C) tem 30 min; limite é 20
    s.engine.tick(); await s.settle();
    expect(s.provider.commands).toHaveLength(0);
  });

  it("alteração externa suspende a regra pelo prazo e depois retoma", async () => {
    const s = await setup({ guards: { ...DEFAULT_GUARDS, overrideSuspendSec: 1800 } });
    await s.advance(12);
    expect(s.state()).toBe("RUNNING");
    s.provider.externalChange({ power: false });
    await s.settle();
    expect(s.state()).toBe("SUSPENDED");
    const n = s.provider.commands.length;
    await s.advance(25); // temperatura sobe, mas a regra segue suspensa
    expect(s.provider.commands.length).toBe(n);
    expect(s.state()).toBe("SUSPENDED");
    await s.advance(10);
    expect(["IDLE", "ARMED", "RUNNING"]).toContain(s.state());
  });

  it("maxRuntime desliga mesmo sem o until ser atingido", async () => {
    const s = await setup({ until: { type: "temp", op: "<=", value: 15 }, guards: { ...DEFAULT_GUARDS, maxRuntimeSec: 2 * 3600 } });
    await s.advance(12);
    expect(s.state()).toBe("RUNNING");
    await s.advance(125);
    expect(s.provider.commands.at(-1)).toEqual({ power: false });
    expect(s.store.ruleRuns(s.row.id)[0]!.outcome).toBe("maxRuntime");
  });

  it("dono único: regra de maior prioridade preempta a de menor", async () => {
    const s = await setup({ when: { type: "temp", op: ">=", value: 27 }, until: { type: "temp", op: "<=", value: 20 }, priority: 10 }, { ambient: 22 });
    const hi: RuleDefinition = {
      name: "forte", deviceId: s.dev.id, enabled: true, priority: 90, when: { type: "temp", op: ">=", value: 28 },
      actions: [{ type: "setAttributes", power: true, mode: "cool", targetTemp: 20 }], until: { type: "temp", op: "<=", value: 20 }, onEnd: [{ type: "setAttributes", power: false }], guards: DEFAULT_GUARDS };
    const hiRow = s.store.saveRule({ deviceId: s.dev.id, name: hi.name, enabled: true, priority: 90, definition: hi });
    s.provider.emitPartial({ currentTemp: 27.5 }); await s.advance(1, false);
    expect(s.state()).toBe("RUNNING"); expect(s.state(hiRow.id)).toBe("IDLE");
    s.provider.emitPartial({ currentTemp: 28.5 }); await s.advance(1, false);
    expect(s.state(hiRow.id)).toBe("RUNNING");
    expect(s.state()).toBe("COOLDOWN");
    expect(s.store.ruleRuns(s.row.id)[0]!.outcome).toBe("preempted");
  });

  it("restart no meio da execução continua e encerra", async () => {
    const s = await setup();
    await s.advance(12);
    expect(s.state()).toBe("RUNNING");
    const engine2 = new AutomationEngine({ store: s.store, gateway: s.core.gateway, clock: { now: s.now }, tz: TZ, state: (id) => s.core.states.get(id), powerSince: (id) => s.core.states.powerSince(id), emit: (e) => s.core.bus.publish(e) });
    for (let i = 0; i < 50; i++) { s.setT(s.now() + 60_000); s.provider.tick(); engine2.tick(); await engine2.idle(); await s.core.gateway.idle(); }
    expect(s.provider.commands.at(-1)).toEqual({ power: false });
    expect(s.store.ruleState(s.row.id)!.state).toBe("COOLDOWN");
  });

  it("breaker suspende sem prazo até resume manual", async () => {
    const s = await setup();
    await s.advance(12);
    s.engine.onBreakerOpen(s.dev.id, "teste");
    expect(s.state()).toBe("SUSPENDED");
    await s.advance(240);
    expect(s.state()).toBe("SUSPENDED");
    s.engine.resume(s.row.id);
    expect(s.state()).toBe("IDLE");
  });

  it("regra desabilitada não roda", async () => {
    const s = await setup({ enabled: false });
    await s.advance(30);
    expect(s.provider.commands).toHaveLength(0);
  });

  it("falha ao desligar tenta de novo e conclui; run termina com o motivo original", async () => {
    const s = await setup();
    await s.advance(12);
    await s.advance(22); // temperatura ainda > 24
    s.provider.failNext.push(new ProviderError("offline", "1222", { code: "1222" }), new ProviderError("offline", "1222", { code: "1222" }));
    await s.advance(25);
    const failed = s.store.commands(s.dev.id).filter((c) => c.status === "failed" && c.errorKind === "offline");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(s.provider.commands.at(-1)).toEqual({ power: false });
    expect(s.state()).toBe("COOLDOWN");
    expect(s.store.ruleRuns(s.row.id)[0]!.outcome).toBe("until");
  });
});
