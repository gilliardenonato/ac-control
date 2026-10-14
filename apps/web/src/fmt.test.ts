import { describe, expect, it } from "vitest";
import { ago, brl, dur, kwh } from "./fmt.ts";
describe("fmt", () => {
  it("dinheiro e energia", () => { expect(brl(3.948)).toContain("3,95"); expect(brl(null)).toBe("—"); expect(kwh(4200)).toBe("4,2 kWh"); });
  it("duração", () => { expect(dur(214)).toBe("3h34"); expect(dur(45)).toBe("45 min"); });
  it("há quanto tempo", () => { expect(ago(undefined)).toBe("nunca"); expect(ago(0, 5 * 60000)).toBe("5 min atrás"); });
});
