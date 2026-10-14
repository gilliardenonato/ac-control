import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LgHttp, LgMqtt, EVENT_EXPIRE } from "../src/index.ts";

class FakeClient extends EventEmitter {
  subs: string[] = []; ended = false;
  subscribe(t: string, _o: unknown, cb?: (e?: Error | null) => void) { this.subs.push(t); cb?.(null); }
  end() { this.ended = true; }
}
function setup() {
  const calls: { method: string; path: string; body?: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    const path = url.replace("https://api-aic.lgthinq.com", ""); const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    if (path === "/route") return new Response(JSON.stringify({ response: { mqttServer: "mqtts://broker.example:8883" } }));
    if (path === "/client/certificate") return new Response(JSON.stringify({ response: { result: { certificatePem: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----", subscriptions: ["app/clients/cid/push"] } } }));
    if (path.startsWith("/push/")) return new Response(JSON.stringify({ error: { code: "1207", message: "already" } }), { status: 400 });
    return new Response(JSON.stringify({ response: {} }));
  }) as unknown as typeof fetch;
  const http = new LgHttp({ pat: "P", country: "BR", clientId: "cid", fetch: fetchImpl });
  const clients: FakeClient[] = [];
  const dir = mkdtempSync(join(tmpdir(), "lgmqtt-"));
  const timeouts: { fn: () => void; ms: number }[] = []; const intervals: { fn: () => void; ms: number }[] = [];
  const timers = { setTimeout: ((fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return timeouts.length; }) as any, clearTimeout: (() => {}) as any, setInterval: ((fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length; }) as any, clearInterval: (() => {}) as any };
  const mq = new LgMqtt({ http, clientId: "cid", dir, connect: () => { const c = new FakeClient(); clients.push(c); return c; }, fetchRootCa: async () => "CA", timers, random: () => 1, renewMs: 1234 });
  return { mq, calls, clients, dir, timeouts, intervals };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("LgMqtt", () => {
  it("registra cliente, gera CSR sem cabeçalhos PEM, guarda credenciais com modo 600", async () => {
    const s = setup(); const health: any[] = [];
    await s.mq.start(() => {}, (h) => health.push(h), () => ["D1"]); await flush();
    const cert = s.calls.find((c) => c.path === "/client/certificate")!;
    expect(cert.body["service-code"]).toBe("SVC202"); expect(cert.body.csr).not.toContain("BEGIN"); expect(cert.body.csr).not.toContain("\n");
    expect(s.calls.find((c) => c.path === "/client")!.body).toMatchObject({ allowExist: true, type: "MQTT" });
    for (const f of ["mqtt.key", "mqtt.crt", "mqtt.topic"]) expect(statSync(join(s.dir, f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(s.dir, "mqtt.topic"), "utf8")).toBe("app/clients/cid/push");
  });
  it("não registra cliente nem pede certificado de novo quando já existem", async () => {
    const s = setup();
    await s.mq.start(() => {}, () => {}, () => []); await flush();
    const before = s.calls.filter((c) => c.path === "/client/certificate").length;
    await s.mq.start(() => {}, () => {}, () => []); await flush();
    expect(s.calls.filter((c) => c.path === "/client/certificate").length).toBe(before);
  });
  it("ao conectar assina tópico, push (1207 tolerado) e event com expire ≤ 24 h; emite connected", async () => {
    const s = setup(); const health: any[] = []; const msgs: any[] = [];
    await s.mq.start((m) => msgs.push(m), (h) => health.push(h), () => ["D1"]); await flush();
    s.clients[0]!.emit("connect"); await flush();
    expect(s.clients[0]!.subs).toEqual(["app/clients/cid/push"]);
    const ev = s.calls.find((c) => c.path === "/event/D1/subscribe")!;
    expect(ev.body).toEqual({ expire: EVENT_EXPIRE }); expect(EVENT_EXPIRE.timer).toBeLessThanOrEqual(24);
    expect(health.at(-1)).toMatchObject({ status: "connected" });
    s.clients[0]!.emit("message", "t", Buffer.from(JSON.stringify({ event: { pushType: "DEVICE_STATUS" } })));
    s.clients[0]!.emit("message", "t", Buffer.from("não é json"));
    expect(msgs).toHaveLength(1);
  });
  it("queda: emite disconnected, agenda reconexão com backoff exponencial e reabre", async () => {
    const s = setup(); const health: any[] = [];
    await s.mq.start(() => {}, (h) => health.push(h), () => ["D1"]); await flush();
    s.clients[0]!.emit("close"); await flush();
    expect(health.at(-1)).toMatchObject({ status: "disconnected" });
    expect(s.timeouts.at(-1)!.ms).toBe(1000);
    s.timeouts.at(-1)!.fn(); await flush();
    expect(s.clients).toHaveLength(2);
    s.clients[1]!.emit("close"); await flush();
    expect(s.timeouts.at(-1)!.ms).toBe(2000); // dobra
    s.timeouts.at(-1)!.fn(); await flush();
    s.clients[2]!.emit("connect"); await flush();
    s.clients[2]!.emit("close"); await flush();
    expect(s.timeouts.at(-1)!.ms).toBe(1000); // conectou: zera
  });
  it("renovação periódica refaz só o event subscribe", async () => {
    const s = setup();
    await s.mq.start(() => {}, () => {}, () => ["D1"]); await flush();
    expect(s.intervals[0]!.ms).toBe(1234);
    const n = s.calls.filter((c) => c.path === "/event/D1/subscribe").length;
    s.intervals[0]!.fn(); await flush();
    expect(s.calls.filter((c) => c.path === "/event/D1/subscribe").length).toBe(n + 1);
    expect(s.calls.filter((c) => c.path === "/push/D1/subscribe").length).toBe(0);
  });
  it("5 falhas seguidas descartam credenciais para regerar", async () => {
    const s = setup();
    await s.mq.start(() => {}, () => {}, () => []); await flush();
    expect(existsSync(join(s.dir, "mqtt.key"))).toBe(true);
    for (let i = 0; i < 5; i++) { s.clients.at(-1)!.emit("error", new Error("Not authorized")); await flush(); if (i < 4) { s.timeouts.at(-1)!.fn(); await flush(); } }
    expect(existsSync(join(s.dir, "mqtt.key"))).toBe(false);
  });
  it("stop encerra o cliente e não reconecta", async () => {
    const s = setup();
    const stop = await s.mq.start(() => {}, () => {}, () => []); await flush();
    stop(); expect(s.clients[0]!.ended).toBe(true);
    s.clients[0]!.emit("close"); await flush();
    expect(s.timeouts).toHaveLength(0);
  });
});
void vi;
