import { describe, expect, it } from "vitest";
import { cumulativeAt, estimateSessionBest, estimateSession, minutesByDay, projectMonth, summarize, tariffAt, costMicro, startOfLocalDay, localDate, addDays } from "../src/index.ts";

const TZ = "America/Sao_Paulo";
const at = (iso: string) => Date.parse(iso);

describe("tempo local", () => {
  it("meia-noite local em UTC-3", () => expect(startOfLocalDay("2026-01-10", TZ)).toBe(at("2026-01-10T00:00:00-03:00")));
  it("localDate respeita o fuso", () => expect(localDate(at("2026-01-10T01:00:00Z"), TZ)).toBe("2026-01-09"));
});

describe("tarifa e custo", () => {
  const tariffs = [{ validFrom: "2026-01-01", priceMicro: 900_000 }, { validFrom: "2026-02-01", priceMicro: 1_000_000 }];
  it("usa a tarifa vigente na data", () => {
    expect(tariffAt(tariffs, "2025-12-31")).toBeUndefined();
    expect(tariffAt(tariffs, "2026-01-31")).toBe(900_000);
    expect(tariffAt(tariffs, "2026-02-01")).toBe(1_000_000);
  });
  it("kWh × tarifa: 4200 Wh a R$0,94 = R$3,948", () => expect(costMicro(4200, 940_000)).toBe(3_948_000));
  it("custo de cada dia usa a tarifa do dia (troca de tarifa no meio)", () => {
    const s = summarize([{ date: "2026-01-31", wh: 1000, final: true }, { date: "2026-02-01", wh: 1000, final: true }], tariffs, "2026-01-31", "2026-02-01");
    expect(s.costMicro).toBe(900_000 + 1_000_000);
    expect(s.basis).toBe("measured"); expect(s.daysWithData).toBe(2);
  });
  it("sem tarifa configurada: custo nulo, não zero", () => {
    expect(summarize([{ date: "2025-12-01", wh: 1000, final: true }], tariffs, "2025-12-01", "2025-12-01").costMicro).toBeNull();
  });
  it("dado parcial de hoje marca provisional", () => {
    expect(summarize([{ date: "2026-01-10", wh: 10, final: false }], tariffs, "2026-01-10", "2026-01-10").provisional).toBe(true);
  });
});

describe("sessões", () => {
  it("fatia sessão que cruza a meia-noite", () => {
    const m = minutesByDay([{ startTs: at("2026-01-10T22:00:00-03:00"), endTs: at("2026-01-11T02:00:00-03:00") }], TZ, 0);
    expect(m.get("2026-01-10")).toBeCloseTo(120); expect(m.get("2026-01-11")).toBeCloseTo(120);
  });
  it("sessão aberta usa `now`", () => {
    const m = minutesByDay([{ startTs: at("2026-01-10T10:00:00-03:00"), endTs: null }], TZ, at("2026-01-10T11:30:00-03:00"));
    expect(m.get("2026-01-10")).toBeCloseTo(90);
  });
  it("propriedade: soma das estimativas das sessões do dia = Wh do dia", () => {
    const sessions = [
      { startTs: at("2026-01-10T08:00:00-03:00"), endTs: at("2026-01-10T09:00:00-03:00") },
      { startTs: at("2026-01-10T20:00:00-03:00"), endTs: at("2026-01-10T23:00:00-03:00") },
    ];
    const energy = [{ date: "2026-01-10", wh: 4000, final: true }];
    const tariffs = [{ validFrom: "2026-01-01", priceMicro: 1_000_000 }];
    const est = sessions.map((s) => estimateSession(s, sessions, energy, tariffs, TZ, 0));
    expect(est[0]!.wh! + est[1]!.wh!).toBeCloseTo(4000);
    expect(est[0]!.wh).toBeCloseTo(1000); expect(est[1]!.wh).toBeCloseTo(3000);
    expect(est[0]!.basis).toBe("estimated"); expect(est[0]!.provisional).toBe(false);
  });
  it("sem energia medida do dia: não inventa", () => {
    const e = estimateSession({ startTs: at("2026-01-10T20:00:00-03:00"), endTs: at("2026-01-10T21:00:00-03:00") }, [], [], [], TZ, 0);
    expect(e.wh).toBeNull(); expect(e.method).toBe("none");
  });
  it("noite que cruza o dia: soma as duas frações", () => {
    const s = { startTs: at("2026-01-10T22:00:00-03:00"), endTs: at("2026-01-11T02:00:00-03:00") };
    const energy = [{ date: "2026-01-10", wh: 1200, final: true }, { date: "2026-01-11", wh: 800, final: true }];
    const e = estimateSession(s, [s], energy, [{ validFrom: "2026-01-01", priceMicro: 1_000_000 }], TZ, 0);
    expect(e.wh).toBeCloseTo(2000); expect(e.perDay).toHaveLength(2);
  });
});

describe("projeção", () => {
  const tariffs = [{ validFrom: "2026-01-01", priceMicro: 1_000_000 }];
  const days = (n: number, wh: number) => Array.from({ length: n }, (_, i) => ({ date: addDays("2026-01-01", i), wh, final: true }));
  it("média diária × dias restantes + já consumido", () => {
    const p = projectMonth({ energy: days(10, 1000), tariffs, today: "2026-01-11", goalCents: 5000 });
    // 10 dias fechados de 1000 Wh; hoje ainda sem leitura → conta 1 dia médio; restam 20 dias
    expect(p.projectedWh).toBeCloseTo(10_000 + 1000 + 20 * 1000);
    expect(p.projectedCostMicro).toBe(31_000_000);
    expect(p.basis).toBe("estimated"); expect(p.sampleDays).toBe(10);
    expect(p.diffToGoalMicro).toBe(31_000_000 - 50_000_000);
  });
  it("sem dias fechados: sem projeção", () => {
    const p = projectMonth({ energy: [], tariffs, today: "2026-01-01" });
    expect(p.projectedWh).toBeNull(); expect(p.projectedCostMicro).toBeNull();
  });
  it("com poucos dias a faixa ainda envolve a projeção (média acima do p25 não inverte)", () => {
    const energy = [10278, 11773, 6128, 9819].map((wh, i) => ({ date: addDays("2026-10-01", i), wh, final: true }));
    const p = projectMonth({ energy, tariffs: [{ validFrom: "2026-01-01", priceMicro: 1_000_000 }], today: "2026-10-05" });
    expect(p.lowCostMicro!).toBeLessThanOrEqual(p.projectedCostMicro!); expect(p.highCostMicro!).toBeGreaterThanOrEqual(p.projectedCostMicro!);
  });
  it("faixa p25..p75 envolve a projeção", () => {
    const energy = Array.from({ length: 8 }, (_, i) => ({ date: addDays("2026-01-01", i), wh: 500 + i * 200, final: true }));
    const p = projectMonth({ energy, tariffs, today: "2026-01-09" });
    expect(p.lowCostMicro!).toBeLessThanOrEqual(p.projectedCostMicro!); expect(p.highCostMicro!).toBeGreaterThanOrEqual(p.lowCostMicro!);
  });
});

describe("energia por diferença do contador", () => {
  const ds = startOfLocalDay("2026-01-10", TZ), de = startOfLocalDay("2026-01-11", TZ);
  const m = (h: number, min = 0) => at(`2026-01-10T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00-03:00`);
  const snaps = [{ ts: m(8, 0), wh: 100 }, { ts: m(8, 10), wh: 200 }, { ts: m(8, 20), wh: 300 }, { ts: m(9, 0), wh: 300 }, { ts: m(10, 0), wh: 300 }];
  it("interpola entre leituras próximas; zero na meia-noite; final no fim do dia", () => {
    expect(cumulativeAt(m(8, 5), ds, de, snaps, null, 0)).toBeCloseTo(150);
    expect(cumulativeAt(ds, ds, de, snaps, null, 0)).toBe(0);
    expect(cumulativeAt(de, ds, de, snaps, 5000, 0)).toBe(5000);
  });
  it("contador parado entre leituras distantes = exato; contador andando com lacuna grande = null", () => {
    expect(cumulativeAt(m(9, 30), ds, de, snaps, null, 0)).toBe(300);
    expect(cumulativeAt(m(8, 25), ds, de, [{ ts: m(8, 20), wh: 300 }, { ts: m(9, 20), wh: 900 }], null, 0)).toBeNull();
  });
  it("sessão estimada por diferença usa o contador; sem leituras cai no proporcional", () => {
    const s = { startTs: m(8, 5), endTs: m(8, 20) }; // consumo 150 → 300
    const map = new Map([["2026-01-10", snaps]]);
    const e = estimateSessionBest(s, [s], [{ date: "2026-01-10", wh: 5000, final: false }], map, [{ validFrom: "2026-01-01", priceMicro: 1_000_000 }], TZ, m(23));
    expect(e.method).toBe("snapshot_delta"); expect(e.wh).toBeCloseTo(150); expect(e.costMicro).toBe(150_000); expect(e.basis).toBe("estimated");
    const f = estimateSessionBest(s, [s], [{ date: "2026-01-10", wh: 500, final: true }], new Map(), [], TZ, m(23));
    expect(f.method).toBe("proportional");
  });
  it("sessão que cruza a meia-noite soma o resto do dia 1 (total final) e o início do dia 2", () => {
    const s = { startTs: at("2026-01-10T23:50:00-03:00"), endTs: at("2026-01-11T00:20:00-03:00") };
    const d1 = [{ ts: at("2026-01-10T23:40:00-03:00"), wh: 1000 }, { ts: at("2026-01-10T23:55:00-03:00"), wh: 1100 }];
    const d2 = [{ ts: at("2026-01-11T00:10:00-03:00"), wh: 50 }, { ts: at("2026-01-11T00:25:00-03:00"), wh: 120 }];
    const e = estimateSessionBest(s, [s], [{ date: "2026-01-10", wh: 1150, final: true }, { date: "2026-01-11", wh: 120, final: false }], new Map([["2026-01-10", d1], ["2026-01-11", d2]]), [], TZ, at("2026-01-11T09:00:00-03:00"));
    expect(e.method).toBe("snapshot_delta"); expect(e.perDay).toHaveLength(2);
    expect(e.wh).toBeCloseTo((1150 - (1000 + 100 * (10 / 15))) + (50 + 70 * (10 / 15) ), 0); // parte dia1 + parte dia2 (interpolada)
  });
});

describe("estimativa de sessão: não atribui consumo de horas não observadas", () => {
  const m = (h: number, min = 0) => at(`2026-01-10T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00-03:00`);
  const tariffs = [{ validFrom: "2026-01-01", priceMicro: 1_000_000 }];
  const day = [{ date: "2026-01-10", wh: 9690, final: false }];
  it("dia monitorado só a partir das 21:57: sem estimativa proporcional (o caso do R$ 12 por hora)", () => {
    const s = { startTs: m(21, 57), endTs: m(22, 48), origin: "unknown" };
    const e = estimateSession(s, [s], day, tariffs, TZ, m(23), { monitoredSince: m(21, 57) });
    expect(e.wh).toBeNull(); expect(e.method).toBe("none"); expect(e.reason).toMatch(/monitorado a partir das 21:57/);
  });
  it("sessão que já estava ligada ao iniciar o monitoramento nunca recebe o total do dia", () => {
    const s = { startTs: m(0, 5), endTs: m(1, 0), origin: "unknown" };
    const e = estimateSession(s, [s], day, tariffs, TZ, m(23), { monitoredSince: m(0, 5) });
    expect(e.wh).toBeNull(); expect(e.reason).toMatch(/já estava ligado/);
  });
  it("dia totalmente monitorado continua dividindo proporcionalmente", () => {
    const s = { startTs: m(8), endTs: m(9), origin: "manual" };
    const s2 = { startTs: m(20), endTs: m(23), origin: "manual" };
    const e = estimateSession(s, [s, s2], [{ date: "2026-01-10", wh: 4000, final: true }], tariffs, TZ, m(23, 59), { monitoredSince: m(0, 1) });
    expect(e.wh).toBeCloseTo(1000); expect(e.method).toBe("proportional");
  });
  it("estimativa acima de 3,5 kW médios é descartada em vez de exibida", () => {
    const s = { startTs: m(8), endTs: m(9), origin: "manual" };
    const e = estimateSession(s, [s], [{ date: "2026-01-10", wh: 20000, final: true }], tariffs, TZ, m(23, 59), { monitoredSince: m(0, 1) });
    expect(e.wh).toBeNull(); expect(e.reason).toMatch(/implausível/);
  });
  it("início do monitoramento: usa a primeira leitura do contador como aproximação (±), sem passar do limite plausível", () => {
    const s = { startTs: m(21, 57), endTs: m(22, 47), origin: "unknown" };
    const snaps = new Map([["2026-01-10", [{ ts: m(21, 58), wh: 9100 }, { ts: m(22, 8), wh: 9200 }, { ts: m(22, 18), wh: 9310 }, { ts: m(22, 28), wh: 9430 }, { ts: m(22, 38), wh: 9540 }, { ts: m(22, 48), wh: 9650 }]]]);
    const e = estimateSessionBest(s, [s], day, snaps, tariffs, TZ, m(22, 50), { monitoredSince: m(21, 57) });
    expect(e.method).toBe("snapshot_delta"); expect(e.wh).toBeGreaterThan(450); expect(e.wh).toBeLessThan(560); // ≈ 0,55 kWh em 50 min
    expect(e.costMicro!).toBeLessThan(700_000);
  });
});
