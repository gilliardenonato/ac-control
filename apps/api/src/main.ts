import { mkdirSync } from "node:fs";
import { openDb } from "@acc/storage";
import { Store, runRetention } from "@acc/storage";
import { FakeProvider } from "@acc/provider-fake";
import { LgHttp, LgMqtt, LgThinqProvider } from "@acc/provider-lg-thinq";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemClock } from "@acc/domain";
import type { ACProvider } from "@acc/provider-api";
import { dbPath, loadConfig } from "./config.ts";
import { createRuntime } from "./runtime.ts";
import { buildServer } from "./server.ts";

const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
const store = new Store(openDb(dbPath(cfg)));

let provider: ACProvider;
if (cfg.provider === "fake") provider = new FakeProvider();
else {
  if (!cfg.lgPat) throw new Error("LG_PAT (ou LG_PAT_FILE) é obrigatório com PROVIDER=lg-thinq");
  mkdirSync(join(cfg.dataDir, "lg"), { recursive: true, mode: 0o700 });
  const idFile = join(cfg.dataDir, "lg", "client-id"); // persistente: não criar clientes novos a cada boot
  if (!existsSync(idFile)) writeFileSync(idFile, randomUUID(), { mode: 0o600 });
  const clientId = readFileSync(idFile, "utf8").trim();
  const http = new LgHttp({ pat: cfg.lgPat, country: cfg.lgCountry, clientId, baseUrl: process.env.LG_BASE_URL });
  provider = new LgThinqProvider({ http, events: new LgMqtt({ http, clientId, dir: join(cfg.dataDir, "lg") }), energyUnitFactor: Number(process.env.LG_ENERGY_UNIT_FACTOR ?? 1) });
}

const rt = createRuntime({ store, provider, clock: systemClock, tz: cfg.tz, retention: () => runRetention(store, Date.now(), cfg.tz) });
const { core, scheduler } = rt;
await core.start();
const app = await buildServer({ core, cfg, domain: rt.domain });
await app.listen({ host: cfg.host, port: cfg.port });
const loop = setInterval(() => { scheduler.runDue().catch((e) => app.log.error({ err: String(e) }, "scheduler")); }, 15_000);
scheduler.runDue().catch(() => {});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { clearInterval(loop); await app.close(); await core.stop(); process.exit(0); });
