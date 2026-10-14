// Regras de dependência: só providers/lg-thinq conhece LG; só o CommandGateway chama setAttributes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (d: string): string[] => {
  try { return readdirSync(d).flatMap((f) => f === "node_modules" ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") || f.endsWith(".tsx") ? [join(d, f)] : []); } catch { return []; }
};
const src = (roots: string[]) => roots.flatMap(walk).map((f) => ({ f, t: readFileSync(f, "utf8") }));

describe("arquitetura", () => {
  it("domínio e demais pacotes não importam LG nem providers concretos", () => {
    const files = src(["packages/domain/src", "packages/provider-api/src", "packages/automation/src", "packages/analytics/src", "packages/storage/src", "packages/contracts/src", "apps/web/src"]);
    for (const { f, t } of files) expect(t, f).not.toMatch(/lg-thinq|provider-lg|thinqconnect|lgthinq/i);
  });
  it("só o gateway (e providers/testes) chama setAttributes", () => {
    const files = src(["packages/domain/src", "packages/automation/src", "packages/analytics/src", "packages/storage/src", "apps/api/src", "apps/web/src"]);
    for (const { f, t } of files) {
      if (/gateway/i.test(f)) continue;
      expect(t, f).not.toMatch(/\.setAttributes\(/);
    }
  });
});
