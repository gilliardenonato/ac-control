import { afterEach, describe, expect, it } from "vitest";
import { FakeProvider } from "@acc/provider-fake";
import { openDb, Store } from "@acc/storage";
import { createRuntime } from "../src/runtime.ts";
import { hashPassword } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";

const baseCfg: Config = { host: "127.0.0.1", port: 0, dataDir: ".", tz: "America/Sao_Paulo", provider: "fake", lgCountry: "BR", secureCookie: false, logLevel: "silent" };

async function make(cfg: Partial<Config> = {}) {
  const store = new Store(openDb(":memory:"));
  const provider = new FakeProvider();
  const rt = createRuntime({ store, provider, clock: { now: () => Date.now() }, tz: "America/Sao_Paulo", sleep: async () => {} });
  const core = rt.core;
  await core.start();
  const app = await buildServer({ core, cfg: { ...baseCfg, ...cfg }, domain: rt.domain });
  await app.ready();
  return { app, core, store, provider, rt };
}
let closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers) await c(); closers = []; });
const mk = async (cfg?: Partial<Config>) => { const x = await make(cfg); closers.push(() => x.app.close(), () => x.core.stop()); return x; };

describe("API (sem auth)", () => {
  it("lista aparelhos com estado, capabilities e frescor", async () => {
    const { app } = await mk();
    const r = await app.inject("/api/v1/devices");
    expect(r.statusCode).toBe(200);
    const [d] = r.json();
    expect(d.state.currentTemp).toBeTypeOf("number");
    expect(d.capabilities.temperature).toMatchObject({ min: 18, max: 30 });
    expect(d.observedAt.currentTemp).toBeTypeOf("number");
  });

  it("POST commands → 202; confirma; estado reflete", async () => {
    const { app, core } = await mk();
    const [d] = (await app.inject("/api/v1/devices")).json();
    const r = await app.inject({ method: "POST", url: `/api/v1/devices/${d.id}/commands`, payload: { attributes: { power: true, targetTemp: 23 } } });
    expect(r.statusCode).toBe(202);
    await core.gateway.idle();
    const c = (await app.inject(`/api/v1/devices/${d.id}/commands/${r.json().id}`)).json();
    expect(c.status).toBe("confirmed");
    expect((await app.inject(`/api/v1/devices/${d.id}`)).json().state).toMatchObject({ power: true, targetTemp: 23 });
  });

  it("comando inválido → 422 problem+json", async () => {
    const { app } = await mk();
    const [d] = (await app.inject("/api/v1/devices")).json();
    const r = await app.inject({ method: "POST", url: `/api/v1/devices/${d.id}/commands`, payload: { attributes: { targetTemp: 99 } } });
    expect(r.statusCode).toBe(422);
    expect(r.headers["content-type"]).toContain("application/problem+json");
    expect(r.json().kind).toBe("invalidCommand");
  });

  it("corpo com campo desconhecido → 422", async () => {
    const { app } = await mk();
    const [d] = (await app.inject("/api/v1/devices")).json();
    const r = await app.inject({ method: "POST", url: `/api/v1/devices/${d.id}/commands`, payload: { attributes: { foo: 1 } } });
    expect(r.statusCode).toBe(422);
  });

  it("dispositivo inexistente → 404", async () => {
    const { app } = await mk();
    expect((await app.inject("/api/v1/devices/nope")).statusCode).toBe(404);
  });

  it("healthz/readyz/openapi", async () => {
    const { app } = await mk();
    expect((await app.inject("/healthz")).json()).toEqual({ ok: true });
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    const spec = (await app.inject("/openapi.json")).json();
    expect(Object.keys(spec.paths)).toContain("/api/v1/devices/{id}/commands");
  });

  it("histórico grava leituras quando o estado muda", async () => {
    const { app, provider, core } = await mk();
    const [d] = (await app.inject("/api/v1/devices")).json();
    await app.inject({ method: "POST", url: `/api/v1/devices/${d.id}/commands`, payload: { attributes: { power: true } } });
    await core.gateway.idle(); provider.tick();
    const h = (await app.inject(`/api/v1/devices/${d.id}/history`)).json();
    expect(h.length).toBeGreaterThanOrEqual(2);
  });
});

describe("API (com auth)", () => {
  const cfg = { adminPasswordHash: hashPassword("segredo"), apiToken: "tok-123456" };
  it("sem credencial → 401; healthz segue público", async () => {
    const { app } = await mk(cfg);
    expect((await app.inject("/api/v1/devices")).statusCode).toBe(401);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
  });
  it("bearer API_TOKEN funciona (inclusive POST, sem CSRF)", async () => {
    const { app } = await mk(cfg);
    const h = { authorization: "Bearer tok-123456" };
    const [d] = (await app.inject({ url: "/api/v1/devices", headers: h })).json();
    const r = await app.inject({ method: "POST", url: `/api/v1/devices/${d.id}/commands`, headers: h, payload: { attributes: { power: true } } });
    expect(r.statusCode).toBe(202);
  });
  it("login: senha errada 401; correta dá cookie HttpOnly; POST exige X-Requested-With", async () => {
    const { app } = await mk(cfg);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: "x" } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: "segredo" } });
    expect(ok.statusCode).toBe(200);
    const sc = String(ok.headers["set-cookie"]);
    expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/SameSite=Strict/i);
    const cookie = sc.split(";")[0]!;
    expect((await app.inject({ url: "/api/v1/devices", headers: { cookie } })).statusCode).toBe(200);
    const [d] = (await app.inject({ url: "/api/v1/devices", headers: { cookie } })).json();
    const noCsrf = await app.inject({ method: "POST", url: `/api/v1/devices/${d.id}/commands`, headers: { cookie }, payload: { attributes: { power: true } } });
    expect(noCsrf.statusCode).toBe(403);
    const withCsrf = await app.inject({ method: "POST", url: `/api/v1/devices/${d.id}/commands`, headers: { cookie, "x-requested-with": "acc" }, payload: { attributes: { power: true } } });
    expect(withCsrf.statusCode).toBe(202);
  });
  it("login tem rate limit", async () => {
    const { app } = await mk(cfg);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: "x" } })).statusCode;
    expect(last).toBe(429);
  });
});

describe("config", () => {
  it("bind não-loopback sem auth é recusado", async () => {
    const { loadConfig } = await import("../src/config.ts");
    expect(() => loadConfig({ HOST: "0.0.0.0" } as any)).toThrow(/exige/);
    expect(() => loadConfig({ HOST: "0.0.0.0", API_TOKEN: "x" } as any)).not.toThrow();
  });
});

describe("SSE", () => {
  it("entrega eventos e reenvia a partir de Last-Event-ID", async () => {
    const { app, core } = await mk();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(app.server.address() as any).port}/api/v1/events/stream`;
    const ac = new AbortController();
    const res = await fetch(url, { signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const [d] = core.store.devices();
    core.bus.publish({ type: "energy.updated", deviceId: d!.id });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("energy.updated")) { const { value } = await reader.read(); text += new TextDecoder().decode(value); }
    expect(text).toMatch(/id: \d+/);
    ac.abort();
    // reconexão: pede só o que passou do último id
    const lastId = core.bus.since(0).at(-1)!.id;
    core.bus.publish({ type: "energy.updated", deviceId: d!.id });
    const ac2 = new AbortController();
    const res2 = await fetch(url, { signal: ac2.signal, headers: { "last-event-id": String(lastId) } });
    const r2 = res2.body!.getReader(); let t2 = "";
    while (!t2.includes("energy.updated")) { const { value } = await r2.read(); t2 += new TextDecoder().decode(value); }
    expect(t2).toContain(`id: ${lastId + 1}`);
    expect(t2).not.toContain(`id: ${lastId}\n`);
    ac2.abort();
  });
});
