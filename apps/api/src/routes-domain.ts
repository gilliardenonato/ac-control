import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { CostQuery, DateRangeQuery, EstimateSettingsSchema, GoalInputSchema, RuleInputSchema, TariffInputSchema } from "@acc/contracts";
import type { RuleInput } from "@acc/contracts";
import { DEFAULT_GUARDS, validateRule } from "@acc/domain";
import type { RuleDefinition } from "@acc/domain";
import { describeRule } from "@acc/automation";
import type { AutomationEngine } from "@acc/automation";
import { addDays, addMonths, costMicro, tariffAt, estimateSessionBest, localDate, minutesByDay, monthOf, projectMonth, startOfLocalDay, summarize } from "@acc/analytics";
import type { Core } from "./core.ts";
import type { EnergySync } from "./energy.ts";
import type { SensorHub } from "./sensors.ts";

const problem = (status: number, title: string, extra: object = {}) => ({ type: "about:blank", title, status, ...extra });
const idParam = z.object({ id: z.string() });

export interface DomainDeps { core: Core; engine: AutomationEngine; energy: EnergySync; sensors: SensorHub; tz: string }

function toDefinition(i: RuleInput): RuleDefinition {
  return { name: i.name, deviceId: i.deviceId, enabled: i.enabled, priority: i.priority, when: i.when as any, actions: i.actions as any, until: i.until as any, onEnd: i.onEnd as any, guards: { ...DEFAULT_GUARDS, ...i.guards } };
}

export function registerDomainRoutes(app0: FastifyInstance, { core, engine, energy, sensors, tz }: DomainDeps) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const store = core.store;
  const now = () => core.clock.now();
  const today = () => localDate(now(), tz);
  const tariffs = () => store.tariffs().map((t) => ({ validFrom: t.validFrom, priceMicro: t.priceMicro }));
  const sensorNames = () => Object.fromEntries(store.sensors().map((s) => [s.id, s.name]));
  const ruleDto = (id: string) => {
    const r = store.rule(id)!; const def = r.definition as RuleDefinition;
    return { id: r.id, version: r.version, ...def, description: describeRule(def, sensorNames()), state: engine.summary(r.deviceId).find((s) => s.ruleId === id) ?? null };
  };

  // ---------- Automações ----------
  app.get("/api/v1/automations", { schema: { tags: ["automations"], querystring: z.object({ deviceId: z.string().optional() }), response: { 200: z.array(z.any()) } } },
    async (req) => store.rules(req.query.deviceId).map((r) => ruleDto(r.id)));

  const check = (i: RuleInput) => {
    const errors = validateRule(toDefinition(i));
    if (!store.device(i.deviceId)) errors.push("deviceId inexistente");
    for (const sid of new Set([...JSON.stringify(i).matchAll(/"sensor":"([^"]+)"/g)].map((m) => m[1]!))) if (!store.sensor(sid)) errors.push(`sensor ${sid} não existe`);
    return errors;
  };
  app.post("/api/v1/automations/validate", { schema: { tags: ["automations"], body: RuleInputSchema } }, async (req) => {
    const errors = check(req.body);
    return { valid: errors.length === 0, errors, description: describeRule(toDefinition(req.body), sensorNames()) };
  });
  app.post("/api/v1/automations", { schema: { tags: ["automations"], body: RuleInputSchema, response: { 201: z.any(), 422: z.any() } } }, async (req, reply) => {
    const errors = check(req.body);
    if (errors.length) return reply.status(422).type("application/problem+json").send(problem(422, "Regra insegura ou inválida", { errors }));
    const def = toDefinition(req.body);
    const r = store.saveRule({ deviceId: def.deviceId, name: def.name, enabled: def.enabled, priority: def.priority, definition: def });
    engine.ruleChanged(r.id, "regra criada");
    return reply.status(201).send(ruleDto(r.id));
  });
  app.put("/api/v1/automations/:id", { schema: { tags: ["automations"], params: idParam, body: RuleInputSchema, response: { 200: z.any(), 404: z.any(), 422: z.any() } } }, async (req, reply) => {
    if (!store.rule(req.params.id)) return reply.status(404).type("application/problem+json").send(problem(404, "Regra não encontrada"));
    const errors = check(req.body);
    if (errors.length) return reply.status(422).type("application/problem+json").send(problem(422, "Regra insegura ou inválida", { errors }));
    const def = toDefinition(req.body);
    store.saveRule({ id: req.params.id, deviceId: def.deviceId, name: def.name, enabled: def.enabled, priority: def.priority, definition: def });
    engine.ruleChanged(req.params.id);
    return ruleDto(req.params.id);
  });
  app.delete("/api/v1/automations/:id", { schema: { tags: ["automations"], params: idParam } }, async (req, reply) => { store.deleteRule(req.params.id); return reply.status(204).send(); });
  for (const action of ["enable", "disable", "resume"] as const) {
    app.post(`/api/v1/automations/:id/${action}`, { schema: { tags: ["automations"], params: idParam, response: { 200: z.any(), 404: z.any(), 409: z.any() } } }, async (req, reply) => {
      const r = store.rule(req.params.id);
      if (!r) return reply.status(404).type("application/problem+json").send(problem(404, "Regra não encontrada"));
      if (action === "resume") {
        if (core.gateway.breakerOpen(r.deviceId)) return reply.status(409).type("application/problem+json").send(problem(409, "Disjuntor aberto: resete-o antes de retomar", { kind: "breaker_open" }));
        engine.resume(r.id);
      } else {
        store.saveRule({ id: r.id, deviceId: r.deviceId, name: r.name, enabled: action === "enable", priority: r.priority, definition: { ...(r.definition as RuleDefinition), enabled: action === "enable" } });
        engine.ruleChanged(r.id); // desabilitar não executa onEnd: a pessoa assume o controle
      }
      return ruleDto(r.id);
    });
  }
  app.get("/api/v1/automations/:id/runs", { schema: { tags: ["automations"], params: idParam, response: { 200: z.array(z.any()) } } }, async (req) => store.ruleRuns(req.params.id, 100));
  app.post("/api/v1/devices/:id/breaker/reset", { schema: { tags: ["devices"], params: idParam } }, async (req) => { core.gateway.resetBreaker(req.params.id); return { ok: true }; });

  // ---------- Tarifa / meta / estimativa ----------
  app.get("/api/v1/tariff", { schema: { tags: ["cost"] } }, async () => {
    const hist = store.tariffs().map((t) => ({ validFrom: t.validFrom, pricePerKwh: t.priceMicro / 1e6, note: t.note }));
    const cur = hist.filter((h) => h.validFrom <= today()).at(-1) ?? null;
    return { current: cur, history: hist };
  });
  app.put("/api/v1/tariff", { schema: { tags: ["cost"], body: TariffInputSchema } }, async (req) => {
    store.addTariff(req.body.validFrom, Math.round(req.body.pricePerKwh * 1e6), req.body.note, now());
    return { ok: true };
  });
  app.get("/api/v1/goals/:month", { schema: { tags: ["cost"], params: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }) } }, async (req) => ({ month: req.params.month, budgetBrl: (store.goal(req.params.month) ?? null) === null ? null : store.goal(req.params.month)! / 100 }));
  app.put("/api/v1/goals/:month", { schema: { tags: ["cost"], params: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), body: GoalInputSchema } }, async (req) => { store.setGoal(req.params.month, Math.round(req.body.budgetBrl * 100)); return { ok: true }; });
  app.get("/api/v1/settings/estimate", { schema: { tags: ["cost"] } }, async () => ({ avgWatts: store.getSetting<number | null>("estimate:avgWatts", null) }));
  app.put("/api/v1/settings/estimate", { schema: { tags: ["cost"], body: EstimateSettingsSchema } }, async (req) => { store.setSetting("estimate:avgWatts", req.body.avgWatts); return { ok: true }; });

  // ---------- Energia / custo ----------
  const energyRows = (deviceId: string, from: string, to: string) => store.energyDaily(deviceId, from, to).map((e) => ({ date: e.date, wh: e.wh, final: e.final }));

  app.get("/api/v1/devices/:id/energy", { schema: { tags: ["energy"], params: idParam, querystring: DateRangeQuery } }, async (req) => {
    const g = req.query.granularity ?? "day";
    const status = energy.status(req.params.id);
    if (g === "month") {
      const to = req.query.to?.slice(0, 7) ?? monthOf(today()), from = req.query.from?.slice(0, 7) ?? addMonths(to, -11);
      const tf = tariffs();
      return { status, granularity: g, points: store.energyMonthly(req.params.id, from, to).map((m) => { const p = tariffAt(tf, `${m.month}-15`); return { key: m.month, wh: m.wh, basis: "measured", collectedAt: m.collectedAt, costBrl: p === undefined ? null : costMicro(m.wh, p) / 1e6 }; }) };
    }
    const to = req.query.to ?? today(), from = req.query.from ?? addDays(to, -30);
    const tf = tariffs();
    return { status, granularity: g, points: store.energyDaily(req.params.id, from, to).map((e) => { const p = tariffAt(tf, e.date); return { key: e.date, wh: e.wh, basis: "measured", final: e.final, collectedAt: e.collectedAt, costBrl: p === undefined ? null : costMicro(e.wh, p) / 1e6 }; }) };
  });

  const periodRange = (period: string, q: { from?: string; to?: string }) => {
    const t = today();
    switch (period) {
      case "today": return { from: t, to: t };
      case "yesterday": return { from: addDays(t, -1), to: addDays(t, -1) };
      case "week": return { from: addDays(t, -6), to: t };
      case "range": return { from: q.from ?? t, to: q.to ?? t };
      default: return { from: `${monthOf(t)}-01`, to: t };
    }
  };
  app.get("/api/v1/devices/:id/costs", { schema: { tags: ["cost"], params: idParam, querystring: CostQuery } }, async (req) => {
    const { from, to } = periodRange(req.query.period, req.query);
    const s = summarize(energyRows(req.params.id, from, to), tariffs(), from, to);
    const status = energy.status(req.params.id);
    return { period: req.query.period, from, to, energyAvailable: status.supported !== false, ...s,
      costBrl: s.costMicro === null ? null : s.costMicro / 1e6, avgDailyWh: s.daysWithData ? s.wh / s.daysWithData : null,
      avgDailyCostBrl: s.costMicro !== null && s.daysWithData ? s.costMicro / 1e6 / s.daysWithData : null,
      avgHourlyWhOnDays: null };
  });

  app.get("/api/v1/devices/:id/projection", { schema: { tags: ["cost"], params: idParam } }, async (req) => projection(req.params.id));
  const projection = (deviceId: string) => {
    const t = today(), month = monthOf(t), prev = addMonths(month, -1);
    const energyDays = energyRows(deviceId, `${prev}-01`, t);
    const prevTotal = summarize(energyDays, tariffs(), `${prev}-01`, addDays(`${month}-01`, -1));
    const g = store.goal(month);
    const p = projectMonth({ energy: energyDays, tariffs: tariffs(), today: t, goalCents: g, previousMonth: prevTotal.daysWithData ? { wh: prevTotal.wh, costMicro: prevTotal.costMicro } : undefined });
    return { ...p, projectedCostBrl: p.projectedCostMicro === null ? null : p.projectedCostMicro / 1e6, goalBrl: g === undefined ? null : g / 100 };
  };

  // ---------- Sessões ----------
  app.get("/api/v1/devices/:id/sessions", { schema: { tags: ["sessions"], params: idParam, querystring: z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() }) } }, async (req) => {
    const to = req.query.to ?? now(), from = req.query.from ?? to - 7 * 86400_000;
    const sessions = store.sessions(req.params.id, from, to);
    const first = localDate(from, tz), last = localDate(to, tz);
    const all = store.sessions(req.params.id, startOfLocalDay(first, tz), startOfLocalDay(addDays(last, 1), tz));
    const e = energyRows(req.params.id, first, last);
    const t = tariffs();
    const monitoredSince = store.firstReadingTs(req.params.id);
    const snapsByDate = new Map<string, { ts: number; wh: number }[]>();
    for (const sn of store.energySnapshots(req.params.id, first, last)) { const a = snapsByDate.get(sn.date) ?? []; a.push({ ts: sn.ts, wh: sn.wh }); snapsByDate.set(sn.date, a); }
    return sessions.map((s) => {
      const est = estimateSessionBest(s, all, e, snapsByDate, t, tz, now(), { monitoredSince });
      return { ...s, durationSec: Math.round(((s.endTs ?? now()) - s.startTs) / 1000), open: s.endTs === null,
        estimate: { basis: "estimated", method: est.method, provisional: est.provisional, reason: est.reason ?? null, wh: est.wh, costBrl: est.costMicro === null ? null : est.costMicro / 1e6 } };
    });
  });

  // ---------- Dashboard (uma chamada para a tela principal) ----------
  app.get("/api/v1/devices/:id/dashboard", { schema: { tags: ["devices"], params: idParam } }, async (req, reply) => {
    const id = req.params.id;
    if (!store.device(id)) return reply.status(404).type("application/problem+json").send(problem(404, "Dispositivo não encontrado"));
    const t = today(), month = monthOf(t);
    const todayStart = startOfLocalDay(t, tz);
    const monthStart = startOfLocalDay(`${month}-01`, tz);
    const sess = store.sessions(id, monthStart, now());
    const mins = minutesByDay(sess, tz, now());
    const onTodayMin = mins.get(t) ?? 0;
    // sessão já ligada quando o app começou a monitorar: a contagem de hoje só vale desde então
    const unknownToday = sess.find((x) => x.origin === "unknown" && localDate(x.startTs, tz) === t);
    const status = energy.status(id);
    const avgWatts = store.getSetting<number | null>("estimate:avgWatts", null);
    const tf = tariffs();
    const costOf = (s: ReturnType<typeof summarize>) => (s.costMicro === null ? null : s.costMicro / 1e6);
    const todaySum = summarize(energyRows(id, t, t), tf, t, t), monthSum = summarize(energyRows(id, `${month}-01`, t), tf, `${month}-01`, t);
    const measuredOk = status.supported !== false && todaySum.daysWithData > 0;
    const monthMin = [...mins.values()].reduce((a, b) => a + b, 0);
    const estToday = avgWatts ? { wh: (onTodayMin / 60) * avgWatts, basis: "estimated" as const } : null;
    const price = tf.length ? tf.filter((x) => x.validFrom <= t).at(-1)?.priceMicro : undefined;
    const brl = (wh: number) => (price === undefined ? null : (wh / 1000) * price / 1e6);
    const today_ = measuredOk
      ? { wh: todaySum.wh, costBrl: costOf(todaySum), basis: "measured", provisional: true }
      : estToday ? { wh: estToday.wh, costBrl: brl(estToday.wh), basis: "estimated", provisional: true } : { wh: null, costBrl: null, basis: null, provisional: false };
    const month_ = monthSum.daysWithData > 0 && status.supported !== false
      ? { wh: monthSum.wh, costBrl: costOf(monthSum), basis: "measured", daysWithData: monthSum.daysWithData }
      : avgWatts ? { wh: (monthMin / 60) * avgWatts, costBrl: brl((monthMin / 60) * avgWatts), basis: "estimated", daysWithData: 0 } : { wh: null, costBrl: null, basis: null, daysWithData: 0 };
    void todayStart;
    return {
      onTodayMinutes: Math.round(onTodayMin), onTodaySince: unknownToday ? unknownToday.startTs : null, energy: status, today: today_, month: month_,
      projection: status.supported !== false ? projection(id) : null,
      automations: engine.summary(id).map((s) => ({ ...s, description: describeRule(store.rule(s.ruleId)!.definition as RuleDefinition, sensorNames()) })),
      breaker: core.gateway.breakerOpen(id), tariffConfigured: price !== undefined, estimateAvgWatts: avgWatts,
    };
  });
}
