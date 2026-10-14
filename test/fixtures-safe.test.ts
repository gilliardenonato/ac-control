// Garante que fixtures/ e o repo não carregam segredos.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const roots = ["fixtures"];
const files = (d: string): string[] => {
  try { return readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)])); } catch { return []; }
};
describe("fixtures sanitizadas", () => {
  const pat = process.env.LG_PAT;
  for (const f of roots.flatMap(files)) {
    it(f, () => {
      const t = readFileSync(f, "utf8");
      expect(t).not.toMatch(/-----BEGIN/);
      expect(t).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
      expect(t).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (pat && pat.length > 8) expect(t).not.toContain(pat);
    });
  }
  it("sanitize remove ids, uuids e PEM", async () => {
    const { sanitize } = await import("../spikes/spike0/sanitize.ts");
    const out = JSON.stringify(sanitize({ deviceId: "abc123", alias: "Sala", userList: ["a@b.c"], x: "id abc123 11111111-2222-3333-4444-555555555555" }, ["abc123"]));
    expect(out).not.toContain("abc123"); expect(out).not.toContain("a@b.c"); expect(out).not.toContain("Sala");
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
describe("segredos fora do git", () => {
  it("o valor do PAT do .env não aparece em nenhum arquivo versionado nem em staged/untracked não ignorado", () => {
    if (!existsSync(".env")) return;
    const m = readFileSync(".env", "utf8").match(/^LG_PAT=(.+)$/m);
    const pat = m?.[1]?.trim();
    if (!pat || pat.length < 8) return;
    const files = execSync("git ls-files -co --exclude-standard", { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const f of files) { try { expect(readFileSync(f, "utf8"), f).not.toContain(pat); } catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; } }
  });
  it("chaves/certificados MQTT e .env estão ignorados", () => {
    for (const f of [".env", "data/lg/mqtt.key", "data/lg/mqtt.crt", "spikes/spike0/out/events.jsonl", "secrets/lg_pat.txt"]) {
      expect(() => execSync(`git check-ignore -q ${f}`)).not.toThrow();
    }
  });
});
