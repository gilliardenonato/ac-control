import { describe, expect, it } from "vitest";
import { providerContract } from "@acc/provider-api/contract";
import { FakeProvider } from "../src/index.ts";

providerContract("fake", async () => ({ provider: new FakeProvider() }));

describe("FakeProvider", () => {
  const mk = () => { let t = 0; const clock = { now: () => t }; return { p: new FakeProvider({ clock }), adv: (min: number) => { t += min * 60000; } }; };
  it("esfria ligado e esquenta desligado", async () => {
    const { p, adv } = mk();
    await p.setAttributes("x", { power: true, targetTemp: 23 });
    adv(30);
    expect((await p.getState()).currentTemp).toBeLessThan(25);
    await p.setAttributes("x", { power: false });
    const cooled = (await p.getState()).currentTemp!;
    adv(60);
    expect((await p.getState()).currentTemp).toBeGreaterThan(cooled);
  });
  it("2304 com aparelho desligado, 2302 comando repetido", async () => {
    const { p } = mk();
    await expect(p.setAttributes("x", { targetTemp: 22 })).rejects.toMatchObject({ kind: "notSupportedInState", code: "2304" });
    await p.setAttributes("x", { power: true });
    await expect(p.setAttributes("x", { power: true })).rejects.toMatchObject({ code: "2302" });
  });
  it("evento de temperatura é parcial", async () => {
    const { p, adv } = mk(); const evs: any[] = [];
    await p.subscribeEvents((e) => evs.push(e));
    await p.setAttributes("x", { power: true }); adv(10); p.tick();
    const last = evs.filter((e) => e.type === "state").at(-1);
    expect(last.fieldsPresent).toEqual(["currentTemp"]);
    expect(last.normalizedState.power).toBeUndefined();
  });
  it("sem energia: unsupported", async () => {
    const p = new FakeProvider({ energy: false });
    await expect(p.getEnergyUsage("x", { from: "2026-01-01", to: "2026-01-02", granularity: "day" })).rejects.toMatchObject({ kind: "unsupported" });
  });
});
