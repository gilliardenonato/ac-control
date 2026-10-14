import { describe, expect, it } from "vitest";
import { providerContract } from "@acc/provider-api/contract";
import { LgHttp, LgThinqProvider, buildCommands, chunk, parseProfile, parseState, parseUsage, toProviderError, LgApiError } from "../src/index.ts";

// Fixtures SINTÉTICAS baseadas na documentação oficial (exemplo de AC). Serão complementadas pelas reais do Spike 0.
const PROFILE = { property: {
  operation: { airConOperationMode: { type: "enum", mode: ["w"], value: { w: ["POWER_OFF", "POWER_ON"] } } },
  airConJobMode: { currentJobMode: { type: "enum", mode: ["r", "w"], value: { r: ["COOL", "AIR_DRY", "FAN", "AUTO", "HEAT", "AIR_CLEAN", "ENERGY_SAVING"], w: ["COOL", "AIR_DRY", "FAN", "AUTO", "HEAT"] } } },
  airFlow: { windStrength: { type: "enum", mode: ["r", "w"], value: { r: ["LOW", "MID", "HIGH", "AUTO"], w: ["LOW", "MID", "HIGH", "AUTO"] } }, windStrengthDetail: { type: "enum", mode: ["r", "w"], value: { w: ["NATURE", "LOW", "MID", "HIGH"] } } },
  temperature: { targetTemperature: { type: "range", mode: ["r", "w"], value: { r: { min: 18, max: 30, step: 1 }, w: { min: 18, max: 30, step: 1 } } }, currentTemperature: { type: "number", mode: ["r"] } },
  windDirection: { rotateUpDown: { type: "boolean", mode: ["r", "w"], value: { w: [false, true] } } },
  powerSave: { powerSaveEnabled: { type: "boolean", mode: ["r", "w"] } },
  airQualitySensor: { humidity: { type: "number", mode: ["r"] } },
} };
const STATE = { airConJobMode: { currentJobMode: "COOL" }, airFlow: { windStrength: "MID" }, operation: { airConOperationMode: "POWER_ON" }, powerSave: { powerSaveEnabled: false },
  temperature: { currentTemperature: 27, targetTemperature: 24.5, unit: "C" }, airQualitySensor: { humidity: 55 } };

type Handler = (method: string, path: string, body?: any) => { status?: number; json: unknown } | undefined;
function mockHttp(h: Handler, log: { method: string; path: string; body?: any }[] = []) {
  const fetchImpl = (async (url: string, init: any) => {
    const path = url.replace("https://api-aic.lgthinq.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push({ method: init.method, path, body });
    const r = h(init.method, path, body) ?? { status: 404, json: { error: { code: "1205", message: "no device" } } };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return new LgHttp({ pat: "SECRET-PAT-VALUE", country: "BR", clientId: "cid", fetch: fetchImpl });
}
const happy: Handler = (m, p) => {
  if (p === "/devices") return { json: { response: { devices: [{ deviceId: "D1", deviceInfo: { deviceType: "DEVICE_AIR_CONDITIONER", alias: "Sala", modelName: "RAC_X" } }, { deviceId: "W1", deviceInfo: { deviceType: "DEVICE_WASHER" } }] } } };
  if (p.endsWith("/profile") && !p.includes("energy")) return { json: { response: PROFILE } };
  if (p.endsWith("/state")) return { json: { response: STATE } };
  if (p.includes("/energy/D1/profile")) return { json: { response: { resultCode: "0000", result: { property: ["energyUsage"] } } } };
  if (p.includes("/energy/D1/usage")) return { json: { response: { resultCode: "0000", result: { dataList: [{ usedDate: "20260110", useAmount: 4200 }] } } } };
  if (m === "POST" && p.endsWith("/control")) return { json: { response: {} } };
};

providerContract("lg-thinq (fetch simulado)", async () => ({ provider: new LgThinqProvider({ http: mockHttp(happy), commandGapMs: 0 }) }));

describe("mapeamento", () => {
  it("profile → capabilities normalizadas (só modos graváveis e mapeáveis; fan com AUTO)", () => {
    const p = parseProfile(PROFILE);
    expect(p.caps.temperature).toEqual({ min: 18, max: 30, step: 1 });
    expect(p.caps.modes.sort()).toEqual(["auto", "cool", "dry", "fan", "heat"]);
    expect(p.caps.fan!.values).toContain("auto"); expect(p.fanKey).toBe("windStrength");
    expect(p.caps.swing).toEqual({ vertical: true, horizontal: false });
    expect(p.caps.humiditySensor).toBe(true); expect(p.caps.power).toBe(true);
  });
  it("perfil sem windStrength usa windStrengthDetail", () => {
    const raw = structuredClone(PROFILE); delete (raw.property.airFlow as any).windStrength;
    const p = parseProfile(raw);
    expect(p.fanKey).toBe("windStrengthDetail"); expect(p.caps.fan!.values).toContain("nature");
  });
  it("estado completo: temperatura alvo decimal e campos", () => {
    const { state, fieldsPresent } = parseState(STATE, parseProfile(PROFILE));
    expect(state).toEqual({ power: true, mode: "cool", targetTemp: 24.5, currentTemp: 27, fan: "mid", humidity: 55 });
    expect(fieldsPresent).toContain("currentTemp");
  });
  it("delta de evento: só o que veio; nada de substituir estado completo", () => {
    const { state, fieldsPresent } = parseState({ temperature: { currentTemperature: 26 } });
    expect(state).toEqual({ currentTemp: 26 }); expect(fieldsPresent).toEqual(["currentTemp"]);
    expect(parseState({ operation: { airConOperationMode: "POWER_OFF" } }).state).toEqual({ power: false });
  });
  it("modo não mapeável (AIR_CLEAN) é ignorado, não vira lixo", () => {
    expect(parseState({ airConJobMode: { currentJobMode: "AIR_CLEAN" } }).fieldsPresent).toEqual([]);
  });
  it("Fahrenheit é convertido para Celsius", () => {
    expect(parseState({ temperature: { currentTemperature: 77, targetTemperature: 66, unit: "F" } }).state).toMatchObject({ currentTemp: 25, targetTemp: 19 });
  });
  it("comandos: power primeiro, depois grupos separados; corpo sem envelope", () => {
    const p = parseProfile(PROFILE);
    expect(buildCommands({ targetTemp: 23, power: true, fan: "auto", mode: "cool", swingV: true }, p)).toEqual([
      { operation: { airConOperationMode: "POWER_ON" } }, { airConJobMode: { currentJobMode: "COOL" } },
      { temperature: { targetTemperature: 23, unit: "C" } }, { airFlow: { windStrength: "AUTO" } }, { windDirection: { rotateUpDown: true } },
    ]);
  });
});

describe("erros", () => {
  const k = (code: string, status = 400) => toProviderError(new LgApiError(code, "x", status));
  it("taxonomia", () => {
    expect(k("1222").kind).toBe("offline");
    expect(k("1306").kind).toBe("rateLimited"); expect(k("1314").kind).toBe("rateLimited"); expect(k("1306").retryable).toBe(true);
    expect(k("1103").kind).toBe("auth"); expect(k("1309").kind).toBe("scope"); expect(k("1221").kind).toBe("unsupported");
    expect(k("2207").kind).toBe("invalidCommand"); expect(k("2304")).toMatchObject({ kind: "notSupportedInState", code: "2304" });
    expect(k("2305").kind).toBe("notSupportedInMode"); expect(k("2210").retryable).toBe(true); expect(k("9999", 503).kind).toBe("transient");
  });
  it("erro de rede vira transient e não vaza o PAT", async () => {
    const http = new LgHttp({ pat: "SECRET-PAT-VALUE", country: "BR", clientId: "c", fetch: (async () => { throw new TypeError("fetch failed"); }) as any });
    const prov = new LgThinqProvider({ http });
    const e = await prov.getDevices().catch((x) => x);
    expect(e.kind).toBe("transient"); expect(String(e.message)).not.toContain("SECRET-PAT-VALUE");
  });
  it("PAT nunca aparece em erros de API", async () => {
    const http = mockHttp(() => ({ status: 401, json: { error: { code: "1103", message: "invalid token" } } }));
    const e = await new LgThinqProvider({ http }).getDevices().catch((x) => x);
    expect(e.kind).toBe("auth"); expect(JSON.stringify(e)).not.toContain("SECRET-PAT-VALUE");
  });
});

describe("provider", () => {
  it("só lista ar-condicionado e usa alias/modelo", async () => {
    const devs = await new LgThinqProvider({ http: mockHttp(happy) }).getDevices();
    expect(devs).toEqual([{ externalId: "D1", name: "Sala", model: "RAC_X" }]);
  });
  it("setAttributes envia um POST por grupo, na ordem, com x-conditional-control e espaçamento", async () => {
    const log: any[] = []; const sleeps: number[] = [];
    const prov = new LgThinqProvider({ http: mockHttp(happy, log), commandGapMs: 2500, sleep: async (ms) => { sleeps.push(ms); } });
    await prov.getCapabilities("D1");
    await prov.setAttributes("D1", { power: true, targetTemp: 23 });
    const posts = log.filter((l) => l.method === "POST");
    expect(posts.map((p) => p.body)).toEqual([{ operation: { airConOperationMode: "POWER_ON" } }, { temperature: { targetTemperature: 23, unit: "C" } }]);
    expect(sleeps).toEqual([2500]);
  });
  it("evento MQTT parcial vira DeviceEvent só com campos presentes", async () => {
    const prov = new LgThinqProvider({ http: mockHttp(happy), clock: { now: () => 123 } });
    const ev = prov.toEvent({ messageId: "m", timestamp: 99, event: { pushType: "DEVICE_STATUS", deviceId: "D1", report: { temperature: { currentTemperature: 26 } } } })!;
    expect(ev).toMatchObject({ deviceId: "D1", source: "mqtt", fieldsPresent: ["currentTemp"], normalizedState: { currentTemp: 26 }, receivedAt: 123, providerTimestamp: 99 });
    expect(prov.toEvent({ event: { pushType: "DEVICE_PUSH", deviceId: "D1" } })).toBeNull();
    expect(prov.toEvent({ pushType: "DEVICE_STATUS", deviceId: "D1", report: { operation: { airConOperationMode: "POWER_OFF" } } })!.normalizedState).toEqual({ power: false });
  });
  it("energia: perfil → caps, uso diário em Wh; 1221 → não suportado", async () => {
    const prov = new LgThinqProvider({ http: mockHttp(happy), clock: { now: () => 5 } });
    expect(await prov.getEnergyCapabilities("D1")).toMatchObject({ supported: true, properties: ["energyUsage"] });
    expect(await prov.getEnergyUsage("D1", { granularity: "day", from: "2026-01-10", to: "2026-01-10" })).toEqual([{ key: "2026-01-10", granularity: "day", wh: 4200, collectedAt: 5 }]);
    const none = new LgThinqProvider({ http: mockHttp((m, p) => (p.includes("/energy/") ? { status: 400, json: { error: { code: "1221", message: "unsupported" } } } : happy(m, p))) });
    expect((await none.getEnergyCapabilities("D1")).supported).toBe(false);
  });
});

describe("energia (parse)", () => {
  it("aceita useAmount e energyUsage; hora/dia/mês", () => {
    const pts = parseUsage({ result: { dataList: [{ usedDate: "2024100908", energyUsage: 80 }, { usedDate: "20241009", useAmount: 100 }, { usedDate: "202410", useAmount: 500 }, { usedDate: "lixo", useAmount: 1 }] } }, 1, 0);
    expect(pts.map((p) => [p.key, p.granularity, p.wh])).toEqual([["2024-10-09T08", "hour", 80], ["2024-10-09", "day", 100], ["2024-10", "month", 500]]);
  });
  it("fator de unidade converte para Wh", () => expect(parseUsage({ dataList: [{ usedDate: "20241009", useAmount: 1.5 }] }, 1000, 0)[0]!.wh).toBe(1500));
  it("janelas: DAILY ≤31 dias, MONTHLY ≤12 meses", () => {
    expect(chunk({ granularity: "day", from: "2026-01-01", to: "2026-03-05" })).toEqual([
      { period: "DAILY", start: "20260101", end: "20260131" }, { period: "DAILY", start: "20260201", end: "20260303" }, { period: "DAILY", start: "20260304", end: "20260305" }]);
    expect(chunk({ granularity: "month", from: "2025-01", to: "2026-03" })).toEqual([{ period: "MONTHLY", start: "202501", end: "202512" }, { period: "MONTHLY", start: "202601", end: "202603" }]);
  });
});
