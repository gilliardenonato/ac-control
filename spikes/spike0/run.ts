// Spike 0 — uso: pnpm spike0 <rest|commands|mqtt [segundos]>
// Saídas brutas em spikes/spike0/out (gitignored); fixtures sanitizadas em fixtures/lg.
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { call, route, save, OUT_DIR } from "./lg.ts";
import { sanitize } from "./sanitize.ts";

const FIX = join(import.meta.dirname, "../../fixtures/lg");
mkdirSync(FIX, { recursive: true });
const cmd = process.argv[2] ?? "rest";

const log = (...a: unknown[]) => console.log(...a);
const brief = (c: { status: number; ms: number; body: any }) =>
  `${c.status} ${c.ms}ms ${c.body?.error ? `ERR ${c.body.error.code} ${c.body.error.message}` : "ok"}`;
const resp = (c: { body: any }) => c.body?.response ?? c.body;

let ids: string[] = [];
function fixture(name: string, data: unknown) {
  writeFileSync(join(FIX, name), JSON.stringify(sanitize(data, ids), null, 2));
}

async function rest() {
  const r = await route();
  log("route", r.status); save("route.json", r);
  const d = await call("GET", "/devices");
  log("devices", brief(d)); save("devices.json", d);
  const list: any[] = resp(d)?.devices ?? resp(d) ?? [];
  const acs = list.filter((x) => x.deviceInfo?.deviceType === "DEVICE_AIR_CONDITIONER" || x.deviceType === "DEVICE_AIR_CONDITIONER");
  ids = list.map((x) => x.deviceId);
  fixture("devices.json", d.body);
  log(`devices: ${list.length}, AC: ${acs.length}`);
  for (const [i, ac] of acs.entries()) {
    const id = ac.deviceId as string;
    const p = await call("GET", `/devices/${id}/profile`); log(`ac${i} profile`, brief(p));
    const s = await call("GET", `/devices/${id}/state`); log(`ac${i} state`, brief(s));
    const ep = await call("GET", `/devices/energy/${id}/profile`); log(`ac${i} energy profile`, brief(ep));
    save(`ac${i}-profile.json`, p); save(`ac${i}-state.json`, s); save(`ac${i}-energy-profile.json`, ep);
    fixture(`ac${i}-profile.json`, p.body); fixture(`ac${i}-state.json`, s.body); fixture(`ac${i}-energy-profile.json`, ep.body);
    const props: string[] = resp(ep)?.property ?? resp(ep)?.result?.property ?? [];
    const today = new Date(); const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const day = (n: number) => ymd(new Date(today.getTime() - n * 86400000));
    for (const prop of props) {
      const q = (period: string, a: string, b: string) => `/devices/energy/${id}/usage?property=${prop}&period=${period}&startDate=${a}&endDate=${b}`;
      const runs: [string, string][] = [
        ["daily-today", q("DAILY", day(0), day(0))], ["daily-yesterday", q("DAILY", day(1), day(1))],
        ["daily-7d", q("DAILY", day(7), day(0))],
        ["monthly-now", q("MONTHLY", day(0).slice(0, 6), day(0).slice(0, 6))],
        ["monthly-3m", q("MONTHLY", ymd(new Date(today.getTime() - 90 * 86400000)).slice(0, 6), day(0).slice(0, 6))],
      ];
      for (const [name, path] of runs) {
        const u = await call("GET", path); log(`ac${i} energy ${prop} ${name}`, brief(u));
        save(`ac${i}-energy-${prop}-${name}.json`, u); fixture(`ac${i}-energy-${prop}-${name}.json`, u.body);
      }
    }
    if (!props.length) log(`ac${i}: energy profile sem propriedades (energia indisponível via API?)`);
  }
}

// Comandos seguros: ajusta temperatura alvo ±1 e restaura. Power só com --allow-power.
async function commands() {
  const d = await call("GET", "/devices");
  const ac = (resp(d)?.devices ?? resp(d)).find((x: any) => (x.deviceInfo?.deviceType ?? x.deviceType) === "DEVICE_AIR_CONDITIONER");
  if (!ac) throw new Error("nenhum AC");
  const id = ac.deviceId as string; ids = [id];
  const state = async () => resp(await call("GET", `/devices/${id}/state`));
  const before = await state(); save("cmd-before.json", before);
  const t0 = before?.temperature?.targetTemperature;
  log("alvo atual", t0, "power", before?.operation?.airConOperationMode);
  const results: any[] = [];
  const send = async (label: string, body: unknown) => {
    const t = Date.now(); const c = await call("POST", `/devices/${id}/control`, body, { "x-conditional-control": "true" });
    log(label, brief(c)); results.push({ label, body, status: c.status, ms: c.ms, resp: c.body });
    await new Promise((r) => setTimeout(r, 5000));
    const st = await state(); results.push({ label: `${label}:state@+5s`, state: st, sinceSendMs: Date.now() - t });
  };
  if (typeof t0 === "number") {
    await send("temp+1", { temperature: { targetTemperature: t0 + 1, unit: "C" } });
    await send("temp restore", { temperature: { targetTemperature: t0, unit: "C" } });
    await send("temp repeat (dedup)", { temperature: { targetTemperature: t0, unit: "C" } });
    await send("temp fora do range", { temperature: { targetTemperature: 99, unit: "C" } });
  }
  if (process.argv.includes("--extras")) { // fan e swing, com restauração
    const fan0 = before?.airFlow?.windStrength, sw0 = before?.windDirection?.rotateUpDown;
    if (fan0) { await send("fan MID", { airFlow: { windStrength: fan0 === "MID" ? "LOW" : "MID" } }); await send("fan restore", { airFlow: { windStrength: fan0 } }); }
    if (typeof sw0 === "boolean") { await send("swing toggle", { windDirection: { rotateUpDown: !sw0 } }); await send("swing restore", { windDirection: { rotateUpDown: sw0 } }); }
  }
  if (process.argv.includes("--allow-power")) {
    const on = before?.operation?.airConOperationMode === "POWER_ON";
    await send(on ? "power off" : "power on", { operation: { airConOperationMode: on ? "POWER_OFF" : "POWER_ON" } });
    await send("power repeat", { operation: { airConOperationMode: on ? "POWER_OFF" : "POWER_ON" } });
    await send("restore power", { operation: { airConOperationMode: on ? "POWER_ON" : "POWER_OFF" } });
  }
  save("cmd-results.json", results); fixture("cmd-results.json", results);
}

async function mqttRun() {
  const secs = Number(process.argv[3] ?? 600);
  const { runMqtt } = await import("./mqtt.ts");
  await runMqtt(secs, OUT_DIR);
}

({ rest, commands, mqtt: mqttRun } as Record<string, () => Promise<void>>)[cmd]?.().catch((e) => { console.error(String(e).replace(/Bearer\s+\S+/g, "Bearer <REDACTED>")); process.exit(1); });
void appendFileSync;
