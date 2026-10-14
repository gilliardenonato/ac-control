import { afterEach, describe, expect, it } from "vitest";
import { FakeProvider } from "@acc/provider-fake";
import { openDb, Store } from "@acc/storage";
import { createRuntime } from "../src/runtime.ts";
import { buildServer } from "../src/server.ts";
import { fetchSensor, parseSensorPayload, POLL_EVERY_MS } from "../src/sensors.ts";
import type { Config } from "../src/config.ts";

const TZ = "America/Sao_Paulo";
const cfg: Config = { host: "127.0.0.1", port: 0, dataDir: ".", tz: TZ, provider: "fake", lgCountry: "BR", secureCookie: false, logLevel: "silent" };
const URL1 = "http://192.168.1.14/sensor";
let closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers) await c(); closers = []; });

/** Simula o ESP32: resposta no formato real `{"sensor":"DHT11","status":"ok","temperature_c":26.7,"humidity_pct":38.0,"uptime_seconds":431}`. */
function esp() {
  const st = { temp: 26.7, hum: 38, status: "ok", down: false, httpStatus: 200, calls: 0 };
  const fetchImpl = (async (url: string) => {
    if (url !== URL1) throw new TypeError("fetch failed");
    st.calls++;
    if (st.down) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ sensor: "DHT11", status: st.status, temperature_c: st.temp, humidity_pct: st.hum, uptime_seconds: 431 }), { status: st.httpStatus });
  }) as unknown as typeof fetch;
  return { st, fetchImpl };
}

async function make(c: Partial<Config> = {}) {
  let t = Date.parse("2026-01-10T20:00:00-03:00");
  const clock = { now: () => t };
  const store = new Store(openDb(":memory:"));
  const provider = new FakeProvider({ clock, ambientC: 29 });
  const e = esp();
  const rt = createRuntime({ store, provider, clock, tz: TZ, sleep: async () => {}, sensorFetch: e.fetchImpl });
  await rt.core.start();
  const app = await buildServer({ core: rt.core, cfg: { ...cfg, ...c }, domain: rt.domain });
  await app.ready();
  closers.push(() => app.close(), () => rt.core.stop());
  const dev = store.devices()[0]!;
  const addSensor = async (name = "ESP32 Sala") => (await app.inject({ method: "POST", url: "/api/v1/sensors", payload: { name, pollUrl: URL1, deviceId: dev.id } })).json() as { id: string };
  const settle = async () => { await rt.engine.idle(); await rt.core.gateway.idle(); await rt.engine.idle(); };
  const minute = async (temp?: number) => { if (temp !== undefined) e.st.temp = temp; t += 60_000; provider.tick(false); await rt.scheduler.runDue(); await settle(); };
  return { app, rt, store, provider, dev, e, addSensor, settle, minute, adv: (ms: number) => { t += ms; }, now: () => t };
}
// regra pedida: acima de 25 °C liga o ar; abaixo de 22 °C desliga (temperatura do sensor da sala)
const rule = (deviceId: string, sensor: string, over: object = {}) => ({
  name: "Sala quente (ESP32)", deviceId,
  when: { type: "all", of: [{ type: "temp", sensor, op: ">", value: 25, forSec: 120 }, { type: "deviceState", power: false }] },
  actions: [{ type: "setAttributes", power: true, mode: "cool", targetTemp: 22 }],
  until: { type: "temp", sensor, op: "<", value: 22 }, onEnd: [{ type: "setAttributes", power: false }], ...over,
});

describe("leitura do sensor (formato do ESP32)", () => {
  it("lê temperature_c / humidity_pct e variações; recusa status de erro, resposta vazia e valores impossíveis", () => {
    expect(parseSensorPayload({ sensor: "DHT11", status: "ok", temperature_c: 26.7, humidity_pct: 38.0, uptime_seconds: 431 })).toEqual({ temperature: 26.7, humidity: 38 });
    expect(parseSensorPayload({ temperature: 24, humidity: 50 })).toEqual({ temperature: 24, humidity: 50 });
    expect(() => parseSensorPayload({ status: "error", temperature_c: 26 })).toThrow(/status/);
    expect(() => parseSensorPayload({ status: "ok" })).toThrow(/sem temperature/);
    expect(() => parseSensorPayload({ temperature_c: 300 })).toThrow(/faixa/);
    expect(() => parseSensorPayload({ temperature_c: 25, humidity_pct: 140 })).toThrow(/faixa/);
    expect(() => parseSensorPayload("lixo")).toThrow();
  });
  it("não segue redirecionamento, recusa HTTP != 200 e resposta que não é JSON", async () => {
    await expect(fetchSensor("http://x/s", (async () => new Response("", { status: 302, headers: { location: "http://evil" } })) as any)).rejects.toThrow(/HTTP 302/);
    await expect(fetchSensor("http://x/s", (async () => new Response("<html>")) as any)).rejects.toThrow(/JSON/);
  });
});

describe("cadastro e consulta", () => {
  it("cadastra com URL alcançável (primeira leitura já aparece); URL inalcançável ou inválida é recusada", async () => {
    const s = await make();
    const ok = await s.app.inject({ method: "POST", url: "/api/v1/sensors", payload: { name: "ESP32 Sala", pollUrl: URL1, deviceId: s.dev.id } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ temperature: 26.7, humidity: 38, online: true, pollUrl: URL1 });
    const down = await s.app.inject({ method: "POST", url: "/api/v1/sensors", payload: { name: "x", pollUrl: "http://10.0.0.99/sensor" } });
    expect(down.statusCode).toBe(422); expect(down.json().title).toMatch(/Não consegui ler/);
    for (const bad of ["file:///etc/passwd", "ftp://x/y", "http://user:pass@192.168.1.14/sensor", "não é url"]) {
      expect((await s.app.inject({ method: "POST", url: "/api/v1/sensors", payload: { name: "x", pollUrl: bad } })).statusCode).toBe(422);
    }
  });
  it("/sensors/test mostra o que o app enxerga sem salvar", async () => {
    const s = await make();
    const r = (await s.app.inject({ method: "POST", url: "/api/v1/sensors/test", payload: { pollUrl: URL1 } })).json();
    expect(r).toMatchObject({ ok: true, reading: { temperature: 26.7, humidity: 38 } });
    expect((await s.app.inject("/api/v1/sensors")).json()).toHaveLength(0);
    s.e.st.down = true;
    expect((await s.app.inject({ method: "POST", url: "/api/v1/sensors/test", payload: { pollUrl: URL1 } })).json().ok).toBe(false);
  });
  it("consulta a cada 30 s; falha registra o erro, o sensor fica 'sem dados' após 5 min e volta sozinho", async () => {
    const s = await make();
    await s.addSensor(); const base = s.e.st.calls;
    await s.rt.sensors.pollDue(); expect(s.e.st.calls).toBe(base);              // ainda no prazo
    s.adv(POLL_EVERY_MS); await s.rt.sensors.pollDue(); expect(s.e.st.calls).toBe(base + 1);
    s.e.st.down = true;
    s.adv(POLL_EVERY_MS); await s.rt.sensors.pollDue();
    let cur = (await s.app.inject("/api/v1/sensors")).json()[0];
    expect(cur.lastError).toMatch(/fetch failed/); expect(cur.online).toBe(true);   // última leitura ainda recente
    s.adv(6 * 60_000); await s.rt.sensors.pollDue();
    cur = (await s.app.inject("/api/v1/sensors")).json()[0]; expect(cur.online).toBe(false);
    s.e.st.down = false; s.e.st.temp = 24.1;
    s.adv(POLL_EVERY_MS); await s.rt.sensors.pollDue();
    cur = (await s.app.inject("/api/v1/sensors")).json()[0]; expect(cur).toMatchObject({ online: true, temperature: 24.1, lastError: null });
  });
  it("histórico grava no máximo 1 leitura por minuto", async () => {
    const s = await make();
    const sensor = await s.addSensor();
    for (let i = 0; i < 8; i++) { s.adv(POLL_EVERY_MS); await s.rt.sensors.pollDue(); }
    expect(s.store.sensorReadings(sensor.id, 0, s.now() + 1).length).toBeLessThanOrEqual(5);
  });
  it("não existe mais endpoint de ingestão por push; com auth ligada /sensors exige login", async () => {
    const s = await make({ apiToken: "adm-123456" });
    expect((await s.app.inject({ method: "POST", url: "/api/v1/ingest/sensor", payload: { temperature: 20 } })).statusCode).toBe(401);
    expect((await s.app.inject("/api/v1/sensors")).statusCode).toBe(401);
    expect((await s.app.inject({ url: "/api/v1/sensors", headers: { authorization: "Bearer adm-123456" } })).statusCode).toBe(200);
  });
});

describe("automação por temperatura do sensor (>25 liga, <22 desliga)", () => {
  it("a regra pedida é aceita, descreve o sensor pelo nome e referência inexistente é recusada", async () => {
    const s = await make();
    const sensor = await s.addSensor("ESP32 Sala");
    const ok = await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id, sensor.id) });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().description.when).toContain("temperatura do sensor ESP32 Sala > 25 °C por 2 min");
    expect((await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id, "nao-existe") })).statusCode).toBe(422);
    expect((await s.app.inject({ method: "DELETE", url: `/api/v1/sensors/${sensor.id}` })).statusCode).toBe(409); // em uso
  });

  it("liga após 2 min acima de 25 °C, segue ligado entre 22 e 25, desliga abaixo de 22; ignora a temperatura do próprio ar", async () => {
    const s = await make();
    const sensor = await s.addSensor();
    await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id, sensor.id) });
    const feed = async (temp: number, minutes: number) => { for (let i = 0; i < minutes; i++) await s.minute(temp); };
    await feed(24, 5);
    expect(s.provider.commands).toHaveLength(0);              // sensor em 24 °C: nada (o ar marca 29 °C, mas a regra olha o sensor)
    await feed(26, 1); expect(s.provider.commands).toHaveLength(0);   // ainda no debounce de 2 min
    await feed(26, 3);
    expect(s.provider.commands[0]).toMatchObject({ power: true, targetTemp: 22 }); // modo já era Frio: dedup não reenvia
    const n = s.provider.commands.length;
    await feed(23.5, 20);                                     // entre 22 e 25: segue ligado, sem novos comandos
    expect(s.provider.commands.length).toBe(n);
    await feed(21.5, 3);
    expect(s.provider.commands.at(-1)).toEqual({ power: false });
    expect(s.store.ruleRuns(s.store.rules()[0]!.id)[0]!.outcome).toBe("until");
  });

  it("sensor fora do ar deixa a regra em espera: nunca liga por leitura velha", async () => {
    const s = await make();
    const sensor = await s.addSensor();
    await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id, sensor.id) });
    await s.minute(30);                                       // última leitura boa: 30 °C
    s.e.st.down = true;
    for (let i = 0; i < 30; i++) await s.minute();            // 30 min sem conseguir ler (limite 20)
    // pode ter ligado nos primeiros minutos com leitura ainda fresca; depois disso, nada novo e a regra não fica ligando/desligando
    const afterFresh = s.provider.commands.length;
    for (let i = 0; i < 10; i++) await s.minute();
    expect(s.provider.commands.length).toBe(afterFresh);
  });

  it("leitura de sensor com mais de 5 min não vale: com debounce longo e sensor fora do ar, nunca liga", async () => {
    const s = await make();
    const sensor = await s.addSensor();
    const longDebounce = rule(s.dev.id, sensor.id, { when: { type: "all", of: [{ type: "temp", sensor: sensor.id, op: ">", value: 25, forSec: 600 }, { type: "deviceState", power: false }] } });
    await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: longDebounce });
    await s.minute(30); s.e.st.down = true;
    for (let i = 0; i < 20; i++) await s.minute();
    expect(s.provider.commands).toHaveLength(0);
  });

  it("se a pessoa já ligou o ar, a regra não assume o controle (só dispara com o ar desligado)", async () => {
    const s = await make();
    const sensor = await s.addSensor();
    await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: rule(s.dev.id, sensor.id) });
    await s.provider.setAttributes("x", { power: true, targetTemp: 20 }); await s.settle();
    for (let i = 0; i < 6; i++) await s.minute(27);
    expect(s.provider.commands.length).toBe(1); // só o comando manual do teste
  });
});

// regra literal: "abaixo de 22 desligar o ar" (vale também quando a pessoa ligou o ar na mão)
const coldRule = (deviceId: string, sensor: string) => ({
  name: "Sala fria (ESP32): desligar", deviceId,
  when: { type: "all", of: [{ type: "temp", sensor, op: "<", value: 22, forSec: 120 }, { type: "deviceState", power: true }] },
  actions: [{ type: "setAttributes", power: false }],
});

describe("desligar quando a sala fica abaixo de 22 °C (mesmo com o ar ligado na mão)", () => {
  it("desliga o ar que estava ligado há tempo, uma única vez, e não religa sozinho", async () => {
    const s = await make();
    const sensor = await s.addSensor();
    await s.provider.setAttributes("x", { power: true, targetTemp: 20 }); await s.settle(); // ligado antes de existir a regra (como no uso real)
    s.adv(15 * 60_000); // já passou do tempo mínimo ligado
    const r = await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: coldRule(s.dev.id, sensor.id) });
    expect(r.statusCode).toBe(201);
    for (let i = 0; i < 2; i++) await s.minute(23);
    expect(s.provider.commands.filter((c) => c.power === false)).toHaveLength(0);   // sala em 23 °C: nada
    for (let i = 0; i < 5; i++) await s.minute(21);
    expect(s.provider.commands.filter((c) => c.power === false)).toHaveLength(1);   // 21 °C por 2+ min: desligou
    for (let i = 0; i < 10; i++) await s.minute(21);
    expect(s.provider.commands.filter((c) => c.power === false)).toHaveLength(1);   // sem repetir
  });
  it("comando manual pelo painel pausa as regras (a pessoa assume o controle)", async () => {
    const s = await make();
    const sensor = await s.addSensor();
    const id = (await s.app.inject({ method: "POST", url: "/api/v1/automations", payload: coldRule(s.dev.id, sensor.id) })).json().id;
    await s.app.inject({ method: "POST", url: `/api/v1/devices/${s.dev.id}/commands`, payload: { attributes: { power: true } } });
    await s.settle();
    expect(s.rt.engine.stateOf(id)).toBe("SUSPENDED");
    for (let i = 0; i < 15; i++) await s.minute(20);     // sala fria, mas a pessoa acabou de ligar: regra pausada por 1 h
    expect(s.provider.commands.filter((c) => c.power === false)).toHaveLength(0);
  });
});
