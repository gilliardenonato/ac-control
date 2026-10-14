// Testes contra payloads REAIS do aparelho do dono (RAC_056905_WW, Brasil), capturados no Spike 0 e sanitizados.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerContract } from "@acc/provider-api/contract";
import { LgHttp, LgThinqProvider, buildCommands, parseProfile, parseState, parseUsage } from "../src/index.ts";

const fx = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, "../../../../fixtures/lg", n), "utf8"));
const profile = fx("ac0-profile.json"), state = fx("ac0-state.json"), devices = fx("devices.json");
const energyProfile = fx("ac0-energy-profile.json"), daily = fx("ac0-energy-energyUsage-daily-7d.json"), monthly = fx("ac0-energy-energyUsage-monthly-3m.json");
const events = fx("events.json");

function mock() {
  const sent: any[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    const p = url.replace("https://api-aic.lgthinq.com", "");
    sent.push({ method: init.method, path: p, body: init.body ? JSON.parse(init.body) : undefined });
    const body = p === "/devices" ? devices : p.includes("/energy/") && p.endsWith("/profile") ? energyProfile : p.includes("/energy/") && p.includes("/usage") ? (p.includes("MONTHLY") ? monthly : daily)
      : p.endsWith("/profile") ? profile : p.endsWith("/state") ? state : { response: {} };
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  return { sent, provider: new LgThinqProvider({ http: new LgHttp({ pat: "x", country: "BR", clientId: "c", fetch: fetchImpl }), commandGapMs: 0, clock: { now: () => 1 } }) };
}

providerContract("lg-thinq (payloads reais)", async () => ({ provider: mock().provider }));

describe("aparelho real RAC_056905_WW", () => {
  it("perfil: modos COOL/AIR_DRY/FAN, alvo 18–30 passo 0,5, fan com AUTO, só swing vertical, sem power-save/umidade", () => {
    const p = parseProfile(profile.response);
    expect(p.caps.modes.sort()).toEqual(["cool", "dry", "fan"]);
    expect(p.caps.temperature).toEqual({ min: 18, max: 30, step: 0.5 });
    expect(p.caps.fan!.values).toEqual(["low", "mid", "high", "auto"]); expect(p.fanKey).toBe("windStrength");
    expect(p.caps.swing).toEqual({ vertical: true, horizontal: false });
    expect(p.caps.powerSave).toBe(false); expect(p.caps.humiditySensor).toBe(false); expect(p.caps.power).toBe(true);
  });
  it("estado real: ligado, COOL, alvo 22, ambiente 28,5, fan high", () => {
    const { state: s } = parseState(state.response, parseProfile(profile.response));
    expect(s).toEqual({ power: true, mode: "cool", targetTemp: 22, currentTemp: 28.5, fan: "high" });
  });
  it("evento real é delta só de temperatura alvo; ambiente e power ficam ausentes (não substituem estado)", () => {
    const prov = mock().provider;
    const ev = prov.toEvent(events[0])!;
    expect(ev.fieldsPresent).toEqual(["targetTemp"]); expect(ev.normalizedState).toEqual({ targetTemp: 23 });
  });
  it("energia real: perfil energyUsage; diário e mensal em Wh, datas locais", async () => {
    const { provider } = mock();
    expect(await provider.getEnergyCapabilities("DEVICE_1")).toMatchObject({ supported: true, properties: ["energyUsage"] });
    const d = parseUsage(daily.response, 1, 0);
    expect(d[0]).toMatchObject({ key: "2026-09-29", granularity: "day", wh: 9759 });
    expect(parseUsage(monthly.response, 1, 0).map((p) => p.key)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
  });
  it("comando de temperatura com passo 0,5 usa targetTemperature e unit C; 22,25 é recusado localmente", async () => {
    const p = parseProfile(profile.response);
    expect(buildCommands({ targetTemp: 22.5 }, p)).toEqual([{ temperature: { targetTemperature: 22.5, unit: "C" } }]);
    const { provider } = mock();
    await expect(provider.setAttributes("DEVICE_1", { targetTemp: 22.25 })).rejects.toMatchObject({ kind: "invalidCommand" });
    await expect(provider.setAttributes("DEVICE_1", { mode: "heat" })).rejects.toMatchObject({ kind: "invalidCommand" });
  });
});
