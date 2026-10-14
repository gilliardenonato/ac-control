import { afterEach, describe, expect, it } from "vitest";
import { ProviderError } from "@acc/domain";
import { FakeProvider } from "@acc/provider-fake";
import { openDb, Store } from "@acc/storage";
import { createRuntime } from "../src/runtime.ts";
import { pollInterval, POLL } from "../src/scheduler.ts";
import { buildServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";

const TZ = "America/Sao_Paulo";
const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: ".", tz: TZ, provider: "fake", lgCountry: "BR", secureCookie: false, logLevel: "silent" };
let closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers) await c(); closers = []; });

async function make(o: { energy?: boolean; start?: string } = {}) {
  let t = Date.parse(o.start ?? "2026-01-10T20:00:00-03:00");
  const clock = { now: () => t };
  const store = new Store(openDb(":memory:"));
  const provider = new FakeProvider({ clock, energy: o.energy ?? true });
  const rt = createRuntime({ store, provider, clock, tz: TZ, sleep: async () => {} });
  await rt.core.start();
  const app = await buildServer({ core: rt.core, cfg, domain: rt.domain });
  await app.ready();
  closers.push(() => app.close(), () => rt.core.stop());
  const dev = store.devices()[0]!;
  const adv = async (min: number) => { for (let i = 0; i < min; i++) { t += 60_000; provider.tick(); } await rt.core.gateway.idle(); };
  const cmd = async (attributes: object) => { await app.inject({ method: "POST", url: `/api/v1/devices/${dev.id}/commands`, payload: { attributes } }); await rt.core.gateway.idle(); };
  return { app, rt, store, provider, dev, adv, cmd, setT: (x: number) => { t = x; }, now: () => t };
}

const rule = (deviceId: string, over: object = {}) => ({
  name: "noite", deviceId, when: { type: "all", of: [{ type: "temp", op: ">=", value: 27, forSec: 600 }, { type: "timeWindow", from: "20:00", to: "06:00" }] },
  actions: [{ type: "setAttributes", power: true, mode: "cool", targetTemp: 23, fan: "auto" }],
  until: { type: "temp", op: "<=", value: 24 }, onEnd: [{ type: "setAttributes", power: false }], ...over,
});

describe("automações (API)", () => {
  it("cria regra segura com descrição legível e estado IDLE", async () => {
    const s = await make();
    const r = await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id) });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.description.when).toContain("temperatura >= 27 °C por 10 min");
    expect(b.description.until).toContain("<= 24");
    expect(b.guards.maxRuntimeSec).toBeGreaterThan(0);
    expect(b.state.state).toBe("IDLE");
  });
  it("recusa regra que liga sem until/onEnd e histerese insuficiente (422 com errors)", async () => {
    const s = await make();
    const a = await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id, { until: undefined, onEnd: undefined }) });
    expect(a.statusCode).toBe(422); expect(a.json().errors.join()).toMatch(/until/);
    const b = await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id, { until: { type: "temp", op: "<=", value: 26.5 } }) });
    expect(b.statusCode).toBe(422); expect(b.json().errors.join()).toMatch(/histerese/);
  });
  it("recusa maxRuntime acima do teto e deviceId inexistente", async () => {
    const s = await make();
    const a = await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id, { guards: { maxRuntimeSec: 999999 } }) });
    expect(a.statusCode).toBe(422);
    const b = await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule("nope") });
    expect(b.statusCode).toBe(422);
  });
  it("validate não salva", async () => {
    const s = await make();
    const r = await s.app.inject({ method: "POST", url: "/api/v1/automations/validate", payload: rule(s.dev.id) });
    expect(r.json().valid).toBe(true);
    expect((await s.app.inject("/api/v1/automations")).json()).toHaveLength(0);
  });
  it("disable/enable/resume e 409 com breaker aberto", async () => {
    const s = await make();
    const id = (await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id) })).json().id;
    expect((await s.app.inject({ method: "POST", url: `/api/v1/automations/${id}/disable` })).json().enabled).toBe(false);
    expect((await s.app.inject({ method: "POST", url: `/api/v1/automations/${id}/enable` })).json().enabled).toBe(true);
    s.store.setSetting(`breaker:${s.dev.id}`, { reason: "teste", at: 1 });
    expect((await s.app.inject({ method: "POST", url: `/api/v1/automations/${id}/resume` })).statusCode).toBe(409);
    await s.app.inject({ method: "POST", url: `/api/v1/devices/${s.dev.id}/breaker/reset` });
    expect((await s.app.inject({ method: "POST", url: `/api/v1/automations/${id}/resume` })).statusCode).toBe(200);
  });
  it("regra criada roda de ponta a ponta pela API (scheduler.tick)", async () => {
    const s = await make();
    await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id) });
    for (let i = 0; i < 14; i++) { await s.adv(1); await s.rt.scheduler.runDue(); await s.rt.engine.idle(); await s.rt.core.gateway.idle(); }
    expect(s.provider.commands[0]).toMatchObject({ power: true, targetTemp: 23 });
    const dash = (await s.app.inject(`/api/v1/devices/${s.dev.id}/dashboard`)).json();
    expect(dash.automations[0]).toMatchObject({ state: "RUNNING" });
    expect(dash.automations[0].description.then).toContain("ligar");
  });
});

describe("tarifa, energia, custo, sessões", () => {
  it("tarifa versionada", async () => {
    const s = await make();
    await s.app.inject({ method: "PUT", url: "/api/v1/tariff", payload: { validFrom: "2026-01-01", pricePerKwh: 0.94 } });
    await s.app.inject({ method: "PUT", url: "/api/v1/tariff", payload: { validFrom: "2026-03-01", pricePerKwh: 1.05 } });
    const t = (await s.app.inject("/api/v1/tariff")).json();
    expect(t.current.pricePerKwh).toBe(0.94); expect(t.history).toHaveLength(2);
  });

  it("sessão abre/fecha, origem manual, energia medida do dia vira custo MEDIDO; sessão tem custo ESTIMADO", async () => {
    const s = await make({ start: "2026-01-10T00:10:00-03:00" }); // monitorado desde o começo do dia
    await s.app.inject({ method: "PUT", url: "/api/v1/tariff", payload: { validFrom: "2026-01-01", pricePerKwh: 1.0 } });
    await s.cmd({ power: true, targetTemp: 23 });
    await s.adv(120); // 2 h ligado: fake consome 600 W → 1200 Wh
    await s.cmd({ power: false });
    await s.rt.scheduler.runDue(); // coleta energia
    const sessions = (await s.app.inject(`/api/v1/devices/${s.dev.id}/sessions`)).json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ open: false, origin: "manual", closedBy: "power_off", targetTemp: 23 });
    expect(sessions[0].durationSec).toBeGreaterThan(7000);
    expect(sessions[0].estimate.basis).toBe("estimated");
    expect(sessions[0].estimate.wh).toBeGreaterThan(1000);
    const costs = (await s.app.inject(`/api/v1/devices/${s.dev.id}/costs?period=today`)).json();
    expect(costs.basis).toBe("measured"); expect(costs.wh).toBeGreaterThan(1000);
    expect(costs.costBrl).toBeCloseTo(costs.wh / 1000, 2);
    const energy = (await s.app.inject(`/api/v1/devices/${s.dev.id}/energy`)).json();
    expect(energy.points[0].basis).toBe("measured"); expect(energy.status.supported).toBe(true);
  });

  it("dashboard sem energia: não inventa; com avgWatts configurado marca ESTIMADO", async () => {
    const s = await make({ energy: false });
    await s.app.inject({ method: "PUT", url: "/api/v1/tariff", payload: { validFrom: "2026-01-01", pricePerKwh: 1.0 } });
    await s.cmd({ power: true }); await s.adv(60);
    await s.rt.scheduler.runDue();
    let d = (await s.app.inject(`/api/v1/devices/${s.dev.id}/dashboard`)).json();
    expect(d.energy.supported).toBe(false);
    expect(d.today).toMatchObject({ wh: null, basis: null }); expect(d.projection).toBeNull();
    expect(d.onTodayMinutes).toBeGreaterThanOrEqual(59);
    await s.app.inject({ method: "PUT", url: "/api/v1/settings/estimate", payload: { avgWatts: 600 } });
    d = (await s.app.inject(`/api/v1/devices/${s.dev.id}/dashboard`)).json();
    expect(d.today.basis).toBe("estimated"); expect(d.today.wh).toBeCloseTo(600, -1); expect(d.today.costBrl).toBeCloseTo(0.6, 1);
  });

  it("custo sem tarifa configurada é null, não zero", async () => {
    const s = await make();
    await s.cmd({ power: true }); await s.adv(60); await s.rt.scheduler.runDue();
    const c = (await s.app.inject(`/api/v1/devices/${s.dev.id}/costs?period=today`)).json();
    expect(c.wh).toBeGreaterThan(0); expect(c.costBrl).toBeNull(); expect(c.missingTariff).toBe(true);
  });

  it("falha de energia 'scope' fica visível no status e não derruba nada", async () => {
    const s = await make();
    s.provider.getEnergyUsage = async () => { throw new ProviderError("scope", "1309", { code: "1309" }); };
    await s.rt.scheduler.runDue();
    const e = (await s.app.inject(`/api/v1/devices/${s.dev.id}/energy`)).json();
    expect(e.status.needsScope).toBe(true); expect(e.status.lastError).toMatch(/escopo/);
  });
});

describe("agendador", () => {
  it("pollInterval: rápido com regra ativa, lento saudável, backoff com teto", () => {
    expect(pollInterval({ fast: true, healthy: true, backoff: 0 })).toBe(POLL.fastMs);
    expect(pollInterval({ fast: false, healthy: true, backoff: 0 })).toBe(POLL.healthyMs);
    expect(pollInterval({ fast: false, healthy: false, backoff: 0 })).toBe(POLL.baseMs);
    expect(pollInterval({ fast: false, healthy: false, backoff: 3 })).toBe(POLL.maxMs);
  });
  it("não faz poll antes do intervalo e respeita rate limit com backoff", async () => {
    const s = await make();
    let calls = 0;
    const orig = s.provider.getState.bind(s.provider);
    s.provider.getState = async () => { calls++; if (calls > 1) throw new ProviderError("rateLimited", "1306"); return orig(); };
    await s.rt.scheduler.runDue(); const first = calls;
    s.setT(s.now() + 60_000); await s.rt.scheduler.runDue();
    expect(calls).toBe(first); // ainda não venceu o intervalo
    s.setT(s.now() + 16 * 60_000); await s.rt.scheduler.runDue();
    expect(calls).toBe(first + 1); // tentou e falhou → backoff
    s.setT(s.now() + 16 * 60_000); await s.rt.scheduler.runDue();
    expect(calls).toBe(first + 1); // intervalo dobrou (30 min) → ainda não
  });
});

describe("reconexão", () => {
  it("volta de disconnected → connected: reconcilia o estado completo", async () => {
    const s = await make();
    let calls = 0; const orig = s.provider.getState.bind(s.provider);
    s.provider.getState = async () => { calls++; return orig(); };
    s.provider.setHealth("disconnected"); s.provider.setHealth("connected");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    s.provider.setHealth("connected"); // já conectado: não repete
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
  });
});

describe("energia por sessão via contador", () => {
  it("lê o contador a cada 10 min ligado e fecha com leitura após desligar → método snapshot_delta", async () => {
    const s = await make({ start: "2026-01-10T20:00:00-03:00" });
    await s.rt.scheduler.runDue();                       // leitura inicial
    await s.adv(5); await s.rt.scheduler.runDue();
    await s.cmd({ power: true, targetTemp: 23 });
    for (let i = 0; i < 6; i++) { await s.adv(10); await s.rt.scheduler.runDue(); }   // 1 h ligado (fake: 600 W)
    await s.cmd({ power: false });
    await s.adv(12); await s.rt.scheduler.runDue();      // leitura "tail" 11 min depois
    const sess = (await s.app.inject(`/api/v1/devices/${s.dev.id}/sessions`)).json();
    expect(sess).toHaveLength(1);
    expect(sess[0].estimate.method).toBe("snapshot_delta");
    expect(sess[0].estimate.basis).toBe("estimated");
    expect(sess[0].estimate.wh).toBeGreaterThan(550); expect(sess[0].estimate.wh).toBeLessThan(680);
  });
});

describe("backfill de energia", () => {
  it("primeira coleta completa pede ~120 dias; as seguintes só 3", async () => {
    const s = await make();
    const froms: string[] = [];
    const orig = s.provider.getEnergyUsage.bind(s.provider);
    s.provider.getEnergyUsage = async (id, q) => { if (q.granularity === "day") froms.push(q.from); return orig(id, q); };
    await s.rt.energy.sync(s.dev.id, "recent"); await s.rt.energy.sync(s.dev.id, "recent");
    expect(froms[0]! < froms[1]!).toBe(true);
    expect(Date.parse(froms[1]!) - Date.parse(froms[0]!)).toBeGreaterThan(100 * 86400_000);
  });
});

describe("histórico de temperatura", () => {
  it("oscilação rápida do sensor grava no máximo 1 ponto por minuto; estado em memória segue instantâneo", async () => {
    const s = await make();
    const before = s.store.readings(s.dev.id, 0, Date.now() * 2).length;
    for (let i = 0; i < 30; i++) { s.provider.emitPartial({ currentTemp: i % 2 ? 28 : 28.5 }); await s.adv(0); s.setT(s.now() + 4000); } // 30 eventos em 2 min
    const after = s.store.readings(s.dev.id, 0, Date.now() * 2).length;
    expect(after - before).toBeLessThanOrEqual(3);
    expect(s.rt.core.states.get(s.dev.id).values.currentTemp).toBe(28);
  });
  it("mudança de power/alvo grava na hora", async () => {
    const s = await make();
    const n = s.store.readings(s.dev.id, 0, Date.now() * 2).length;
    s.setT(s.now() + 1000); // relógio de teste parado: avança para o ponto novo não substituir o anterior
    await s.cmd({ power: true });
    expect(s.store.readings(s.dev.id, 0, Date.now() * 2).length).toBeGreaterThan(n);
  });
});
