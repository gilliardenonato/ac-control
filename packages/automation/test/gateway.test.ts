import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GUARDS, ProviderError, StateStore } from "@acc/domain";
import { FakeProvider } from "@acc/provider-fake";
import { openDb, Store } from "@acc/storage";
import { CommandGateway, GatewayEvent } from "../src/index.ts";

function setup(opts: { cfg?: object } = {}) {
  const store = new Store(openDb(":memory:"));
  const dev = store.upsertDevice("fake", "fake-ac-1", "AC");
  let t = 1_000_000_000_000;
  const clock = { now: () => t };
  const provider = new FakeProvider({ clock });
  const states = new StateStore();
  const events: GatewayEvent[] = [];
  provider.subscribeEvents((e) => { if (e.type === "state") { states.apply({ ...e, deviceId: dev.id }); gw.onState(dev.id); } });
  const gw: CommandGateway = new CommandGateway({
    store, provider, clock, sleep: async (ms) => { t += ms; },
    externalId: () => "fake-ac-1", capabilities: (id) => provider.getCapabilities(),
    state: (id) => states.get(id), powerSince: (id) => states.powerSince(id),
    refreshState: async (id) => { const s = await provider.getState(); states.apply({ deviceId: id, receivedAt: t, fieldsPresent: Object.keys(s) as any, normalizedState: s }); },
    emit: (e) => events.push(e), config: opts.cfg as any,
  });
  states.apply({ deviceId: dev.id, receivedAt: t, fieldsPresent: ["power"], normalizedState: { power: false } }); // baseline: próximas mudanças são transições
  const adv = (ms: number) => { t += ms; };
  return { store, dev, provider, gw, states, events, adv, clock };
}
const auto = (id = "r1") => ({ origin: `automation:${id}` as const, ruleId: undefined, guards: { minOnSec: 600, minOffSec: 300, maxCommandsPerHour: 6 } });

describe("CommandGateway", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => { s = setup(); await s.provider.getState(); });

  it("envia, confirma por evento e registra latência", async () => {
    const c = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true, targetTemp: 23 }, origin: "manual" });
    expect(c.status).toBe("pending");
    await s.gw.idle();
    const done = s.store.command(c.id)!;
    expect(done.status).toBe("confirmed");
    expect(s.provider.commands).toEqual([{ power: true, targetTemp: 23 }]);
  });

  it("dedup: estado já desejado não envia", async () => {
    await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, origin: "manual" }); await s.gw.idle();
    const c = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, origin: "manual" });
    expect(c).toMatchObject({ status: "skipped", skipReason: "already_in_state" });
    expect(s.provider.commands.length).toBe(1);
  });

  it("dedup parcial: remove só o que já vale", async () => {
    await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true, targetTemp: 23 }, origin: "manual" }); await s.gw.idle();
    await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true, targetTemp: 22 }, origin: "manual" }); await s.gw.idle();
    expect(s.provider.commands.at(-1)).toEqual({ targetTemp: 22 });
  });

  it("idempotencyKey devolve o mesmo comando", async () => {
    const a = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, origin: "manual", idempotencyKey: "k1" });
    const b = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, origin: "manual", idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
  });

  it("valida contra capabilities (fora do range, modo/fan inexistente)", async () => {
    for (const attributes of [{ targetTemp: 40 }, { targetTemp: 22.5 }, { mode: "xxx" as any }, { fan: "turbo" }]) {
      const c = await s.gw.submit({ deviceId: s.dev.id, attributes, origin: "manual" });
      expect(c).toMatchObject({ status: "failed", errorKind: "invalidCommand" });
    }
    expect(s.provider.commands.length).toBe(0);
  });

  it("2304 ao desligar aparelho já desligado vira skipped (idempotente)", async () => {
    // estado ainda desconhecido -> envia -> provider responde 2304/2302
    const c = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: false }, origin: "manual" }); await s.gw.idle();
    expect(s.store.command(c.id)).toMatchObject({ status: "skipped", skipReason: "already_in_state" });
  });

  it("erro transitório: retry e sucesso", async () => {
    s.provider.failNext.push(new ProviderError("transient", "2210", { code: "2210" }));
    const c = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, origin: "manual" }); await s.gw.idle();
    expect(s.store.command(c.id)!.status).toBe("confirmed");
  });

  it("offline: falha com errorKind offline, sem retry", async () => {
    s.provider.offline = true;
    const c = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, origin: "manual" }); await s.gw.idle();
    expect(s.store.command(c.id)).toMatchObject({ status: "failed", errorKind: "offline" });
  });

  it("minOn: automação não desliga logo após ligar; force ignora; manual ignora", async () => {
    await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, origin: "manual" }); await s.gw.idle();
    s.adv(60_000);
    const a = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: false }, ...auto() });
    expect(a).toMatchObject({ status: "skipped", skipReason: "min_on" });
    const f = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: false }, ...auto(), force: true }); await s.gw.idle();
    expect(s.store.command(f.id)!.status).toBe("confirmed");
  });

  it("minOff: automação não religa logo após desligar", async () => {
    await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, origin: "manual" }); await s.gw.idle();
    await s.gw.submit({ deviceId: s.dev.id, attributes: { power: false }, origin: "manual" }); await s.gw.idle();
    s.adv(30_000);
    const a = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, ...auto() });
    expect(a).toMatchObject({ status: "skipped", skipReason: "min_off" });
    s.adv(400_000);
    const b = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true }, ...auto() });
    expect(b.status).toBe("pending");
  });

  it("flip-flop de power por automação abre o breaker; manual continua funcionando", async () => {
    const g = { minOnSec: 0, minOffSec: 0, maxCommandsPerHour: 20 };
    const res: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: i % 2 === 0 }, origin: "automation:r1", guards: g, force: true }); await s.gw.idle();
      res.push(s.store.command(c.id)!.status === "skipped" ? s.store.command(c.id)!.skipReason! : "ok"); s.adv(10_000);
    }
    expect(res).toEqual(["ok", "ok", "ok", "breaker_open", "already_in_state"]); // force ignora breaker; dedup vale
    expect(s.gw.breakerOpen(s.dev.id)).not.toBeNull();
    expect(s.events.some((e) => e.type === "breaker.open")).toBe(true);
    const m = await s.gw.submit({ deviceId: s.dev.id, attributes: { power: false }, origin: "manual" }); await s.gw.idle();
    expect(s.store.command(m.id)!.status).toBe("confirmed");
    s.gw.resetBreaker(s.dev.id);
    expect(s.gw.breakerOpen(s.dev.id)).toBeNull();
  });

  it("limite por hora da regra abre o breaker", async () => {
    const g = { minOnSec: 0, minOffSec: 0, maxCommandsPerHour: 2 };
    await s.gw.submit({ deviceId: s.dev.id, attributes: { power: true, targetTemp: 20 }, origin: "manual" }); await s.gw.idle();
    const out: string[] = [];
    for (const t of [21, 22, 23, 24]) {
      const c = await s.gw.submit({ deviceId: s.dev.id, attributes: { targetTemp: t }, origin: "automation:r2", guards: g }); await s.gw.idle();
      out.push(s.store.command(c.id)!.status); s.adv(10_000);
    }
    expect(out.filter((x) => x === "skipped").length).toBeGreaterThanOrEqual(1);
    expect(s.gw.breakerOpen(s.dev.id)).not.toBeNull();
  });

  it("teto global por hora (qualquer origem)", async () => {
    const x = setup({ cfg: { globalMaxPerHour: 3 } }); await x.provider.getState();
    await x.gw.submit({ deviceId: x.dev.id, attributes: { power: true, targetTemp: 20 }, origin: "manual" }); await x.gw.idle();
    const r: string[] = [];
    for (const t of [21, 22, 23, 24]) { const c = await x.gw.submit({ deviceId: x.dev.id, attributes: { targetTemp: t }, origin: "manual" }); await x.gw.idle(); r.push(x.store.command(c.id)!.skipReason ?? x.store.command(c.id)!.status); x.adv(5000); }
    expect(r).toContain("rate_limited");
  });
});
void DEFAULT_GUARDS;
