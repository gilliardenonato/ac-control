// Amostra o acumulado de "hoje" a cada N segundos para descobrir a cadência real de atualização da energia.
import { call } from "./lg.ts";
const N = Number(process.argv[2] ?? 60), COUNT = Number(process.argv[3] ?? 10);
const id = ((await call("GET", "/devices")).body.response as any[])[0].deviceId as string;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(Date.now()).replace(/-/g, "");
let prev: number | undefined;
for (let i = 0; i < COUNT; i++) {
  const r = await call("GET", `/devices/energy/${id}/usage?property=energyUsage&period=DAILY&startDate=${today}&endDate=${today}`);
  const v = r.body?.response?.result?.dataList?.[0]?.energyUsage as number | undefined;
  const st = await call("GET", `/devices/${id}/state`);
  const s = st.body?.response;
  console.log(new Date().toLocaleTimeString("pt-BR"), "hoje Wh:", v, prev !== undefined && v !== undefined ? `(Δ ${v - prev})` : "", "| power", s?.operation?.airConOperationMode, "temp", s?.temperature?.currentTemperature);
  prev = v ?? prev;
  if (i < COUNT - 1) await new Promise((res) => setTimeout(res, N * 1000));
}
