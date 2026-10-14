// Sonda de energia: descobre fuso dos dias, granularidade de "hoje" e limites. Uso: pnpm exec tsx --env-file=.env spikes/spike0/energy-probe.ts
import { call } from "./lg.ts";
const d = await call("GET", "/devices");
const id = (d.body.response as any[])[0].deviceId as string;
const loc = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(Date.now() - n * 86400000).replace(/-/g, "");
const utc = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
console.log("local hoje", loc(0), "utc hoje", utc(0));
const q = async (label: string, period: string, a: string, b: string) => {
  const r = await call("GET", `/devices/energy/${id}/usage?property=energyUsage&period=${period}&startDate=${a}&endDate=${b}`);
  const list = r.body?.response?.result?.dataList;
  console.log(label, r.status, r.body?.error ? `ERR ${r.body.error.code}` : JSON.stringify(list));
};
await q("DAILY hoje(local) single", "DAILY", loc(0), loc(0));
await q("DAILY hoje(utc)   single", "DAILY", utc(0), utc(0));
await q("DAILY ontem(local) single", "DAILY", loc(1), loc(1));
await q("DAILY 2d (local-1..local)", "DAILY", loc(1), loc(0));
await q("DAILY amanhã(utc) range", "DAILY", loc(1), utc(0));
await q("MONTHLY mes atual", "MONTHLY", loc(0).slice(0, 6), loc(0).slice(0, 6));
await q("DAILY 31 dias", "DAILY", loc(30), loc(0));
await q("DAILY 32 dias", "DAILY", loc(31), loc(0));
await q("DAILY 90 dias (limite?)", "DAILY", loc(89), loc(0));
await q("MONTHLY 12m", "MONTHLY", loc(364).slice(0, 6), loc(0).slice(0, 6));
await q("MONTHLY 13m", "MONTHLY", loc(395).slice(0, 6), loc(0).slice(0, 6));
