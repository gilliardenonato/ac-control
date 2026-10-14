// Suíte de contrato: roda contra qualquer ACProvider (fake, provider real com fixtures).
import { describe, expect, it } from "vitest";
import type { ACProvider } from "./index.ts";

export function providerContract(name: string, make: () => Promise<{ provider: ACProvider; cleanup?: () => void }>) {
  describe(`ACProvider contract: ${name}`, () => {
    it("lista dispositivos com externalId e nome", async () => {
      const { provider, cleanup } = await make();
      const devs = await provider.getDevices();
      expect(devs.length).toBeGreaterThan(0);
      for (const d of devs) { expect(d.externalId).toBeTruthy(); expect(d.name).toBeTruthy(); }
      cleanup?.();
    });
    it("capabilities normalizadas e estado coerente", async () => {
      const { provider, cleanup } = await make();
      const [d] = await provider.getDevices();
      const caps = await provider.getCapabilities(d!.externalId);
      expect(Array.isArray(caps.modes)).toBe(true);
      expect(typeof caps.energy.supported).toBe("boolean");
      const st = await provider.getState(d!.externalId);
      if (caps.temperature && st.targetTemp !== undefined) {
        expect(st.targetTemp).toBeGreaterThanOrEqual(caps.temperature.min);
        expect(st.targetTemp).toBeLessThanOrEqual(caps.temperature.max);
      }
      cleanup?.();
    });
    it("rejeita temperatura fora do range com invalidCommand", async () => {
      const { provider, cleanup } = await make();
      const [d] = await provider.getDevices();
      const caps = await provider.getCapabilities(d!.externalId);
      if (caps.temperature) {
        await expect(provider.setAttributes(d!.externalId, { targetTemp: caps.temperature.max + 50 })).rejects.toMatchObject({ kind: "invalidCommand" });
      }
      cleanup?.();
    });
  });
}
