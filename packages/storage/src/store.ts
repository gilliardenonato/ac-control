import type { AttributePatch, NormalizedState, Origin } from "@acc/domain";
import type { DB } from "./db.ts";
import { newId } from "./db.ts";

export interface DeviceRow { id: string; provider: string; externalId: string; name: string; model: string | null; createdAt: number }
export interface CommandRow {
  id: string; deviceId: string; createdAt: number; origin: string; ruleId: string | null; idempotencyKey: string | null;
  attributes: AttributePatch; status: string; skipReason: string | null; errorKind: string | null; errorCode: string | null;
  sentAt: number | null; confirmedAt: number | null; latencyMs: number | null;
}
export interface RuleRow { id: string; deviceId: string; name: string; enabled: boolean; priority: number; definition: unknown; version: number }
export interface RuleStateRow { ruleId: string; state: string; since: number; untilTs: number | null; context: any }
export interface SessionRow {
  id: string; deviceId: string; startTs: number; endTs: number | null; tempStart: number | null; tempEnd: number | null;
  targetTemp: number | null; mode: string | null; fan: string | null; origin: string | null; ruleId: string | null; closedBy: string | null;
  energyWhEst: number | null; costEst: number | null; estimateMethod: string | null;
}
export interface SensorRow { id: string; name: string; pollUrl: string; deviceId: string | null; createdAt: number; lastTs: number | null; lastTemp: number | null; lastHum: number | null; lastError: string | null }
export interface ReadingRow { deviceId: string; ts: number; power: boolean | null; mode: string | null; targetTemp: number | null; currentTemp: number | null; fan: string | null; humidity: number | null; source: string }

const b = (v: number | null | undefined) => (v === null || v === undefined ? null : v === 1);
const ob = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);

/** Acesso a dados em SQL explícito. Sem ORM: o schema é pequeno e o SQL é portável. */
export class Store {
  constructor(public db: DB) {}

  // devices
  upsertDevice(provider: string, externalId: string, name: string, model?: string, now = Date.now()): DeviceRow {
    this.db.prepare("INSERT INTO device (id, provider, external_id, name, model, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(provider, external_id) DO UPDATE SET name=excluded.name, model=excluded.model")
      .run(newId(now), provider, externalId, name, model ?? null, now);
    return this.deviceByExternal(provider, externalId)!;
  }
  deviceByExternal(provider: string, externalId: string): DeviceRow | undefined {
    return this.mapDevice(this.db.prepare("SELECT * FROM device WHERE provider=? AND external_id=?").get(provider, externalId));
  }
  device(id: string): DeviceRow | undefined { return this.mapDevice(this.db.prepare("SELECT * FROM device WHERE id=?").get(id)); }
  devices(): DeviceRow[] { return (this.db.prepare("SELECT * FROM device ORDER BY created_at").all() as any[]).map((r) => this.mapDevice(r)!); }
  private mapDevice(r: any): DeviceRow | undefined { return r && { id: r.id, provider: r.provider, externalId: r.external_id, name: r.name, model: r.model, createdAt: r.created_at }; }

  // capabilities
  saveCapabilities(deviceId: string, hash: string, normalized: unknown, now = Date.now()): boolean {
    const last = this.db.prepare("SELECT profile_hash h FROM capability_snapshot WHERE device_id=? ORDER BY seen_at DESC LIMIT 1").get(deviceId) as { h: string } | undefined;
    if (last?.h === hash) return false;
    this.db.prepare("INSERT INTO capability_snapshot VALUES (?,?,?,?,?)").run(newId(now), deviceId, hash, JSON.stringify(normalized), now);
    return true;
  }

  // readings / events
  insertReading(deviceId: string, ts: number, s: NormalizedState, source: string) {
    this.db.prepare("INSERT OR REPLACE INTO reading VALUES (?,?,?,?,?,?,?,?,?)")
      .run(deviceId, ts, ob(s.power), s.mode ?? null, s.targetTemp ?? null, s.currentTemp ?? null, s.fan ?? null, s.humidity ?? null, source);
  }
  readings(deviceId: string, from: number, to: number, limit = 5000): ReadingRow[] {
    return (this.db.prepare("SELECT * FROM reading WHERE device_id=? AND ts>=? AND ts<=? ORDER BY ts LIMIT ?").all(deviceId, from, to, limit) as any[]).map((r) => ({
      deviceId: r.device_id, ts: r.ts, power: b(r.power), mode: r.mode, targetTemp: r.target_temp, currentTemp: r.current_temp, fan: r.fan, humidity: r.humidity, source: r.source }));
  }
  /** Quando o app começou a observar o aparelho (primeira leitura gravada). */
  firstReadingTs(deviceId: string): number | null { return ((this.db.prepare("SELECT MIN(ts) t FROM reading WHERE device_id=?").get(deviceId) as { t: number | null }).t); }
  insertEventRaw(deviceId: string | null, at: number, source: string, payload: unknown) {
    this.db.prepare("INSERT INTO event_raw (device_id, received_at, source, payload_json) VALUES (?,?,?,?)").run(deviceId, at, source, JSON.stringify(payload));
  }

  // commands
  insertCommand(c: { deviceId: string; origin: Origin | string; ruleId?: string; idempotencyKey?: string; attributes: AttributePatch; now: number }): CommandRow {
    const id = newId(c.now);
    this.db.prepare("INSERT INTO command (id, device_id, created_at, origin, rule_id, idempotency_key, attributes_json, status) VALUES (?,?,?,?,?,?,?, 'pending')")
      .run(id, c.deviceId, c.now, c.origin, c.ruleId ?? null, c.idempotencyKey ?? null, JSON.stringify(c.attributes));
    return this.command(id)!;
  }
  commandByIdempotency(deviceId: string, key: string): CommandRow | undefined {
    return this.mapCommand(this.db.prepare("SELECT * FROM command WHERE device_id=? AND idempotency_key=?").get(deviceId, key));
  }
  command(id: string): CommandRow | undefined { return this.mapCommand(this.db.prepare("SELECT * FROM command WHERE id=?").get(id)); }
  updateCommand(id: string, p: Partial<{ status: string; skipReason: string; errorKind: string; errorCode: string; sentAt: number; confirmedAt: number; latencyMs: number }>) {
    const cols: Record<string, string> = { status: "status", skipReason: "skip_reason", errorKind: "error_kind", errorCode: "error_code", sentAt: "sent_at", confirmedAt: "confirmed_at", latencyMs: "latency_ms" };
    const keys = Object.keys(p).filter((k) => (p as any)[k] !== undefined);
    if (!keys.length) return;
    this.db.prepare(`UPDATE command SET ${keys.map((k) => `${cols[k]}=?`).join(",")} WHERE id=?`).run(...keys.map((k) => (p as any)[k]), id);
  }
  commands(deviceId: string, limit = 50): CommandRow[] {
    return (this.db.prepare("SELECT * FROM command WHERE device_id=? ORDER BY created_at DESC LIMIT ?").all(deviceId, limit) as any[]).map((r) => this.mapCommand(r)!);
  }
  /** Comandos efetivamente enviados desde `since` (para limite/hora e dedup de flip-flop). */
  sentCommandsSince(deviceId: string, since: number): CommandRow[] {
    return (this.db.prepare("SELECT * FROM command WHERE device_id=? AND created_at>=? AND status IN ('sent','confirmed') ORDER BY created_at").all(deviceId, since) as any[]).map((r) => this.mapCommand(r)!);
  }
  private mapCommand(r: any): CommandRow | undefined {
    return r && { id: r.id, deviceId: r.device_id, createdAt: r.created_at, origin: r.origin, ruleId: r.rule_id, idempotencyKey: r.idempotency_key, attributes: JSON.parse(r.attributes_json),
      status: r.status, skipReason: r.skip_reason, errorKind: r.error_kind, errorCode: r.error_code, sentAt: r.sent_at, confirmedAt: r.confirmed_at, latencyMs: r.latency_ms };
  }

  // rules
  saveRule(r: { id?: string; deviceId: string; name: string; enabled: boolean; priority: number; definition: unknown }, now = Date.now()): RuleRow {
    const id = r.id ?? newId(now);
    this.db.prepare(`INSERT INTO rule (id, device_id, name, enabled, priority, definition_json, version, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, priority=excluded.priority, definition_json=excluded.definition_json, version=version+1, updated_at=excluded.updated_at`)
      .run(id, r.deviceId, r.name, r.enabled ? 1 : 0, r.priority, JSON.stringify(r.definition), now, now);
    return this.rule(id)!;
  }
  rule(id: string): RuleRow | undefined { return this.mapRule(this.db.prepare("SELECT * FROM rule WHERE id=?").get(id)); }
  rules(deviceId?: string): RuleRow[] {
    const rows = deviceId ? this.db.prepare("SELECT * FROM rule WHERE device_id=? ORDER BY priority DESC, created_at").all(deviceId) : this.db.prepare("SELECT * FROM rule ORDER BY priority DESC, created_at").all();
    return (rows as any[]).map((r) => this.mapRule(r)!);
  }
  deleteRule(id: string) { this.db.prepare("DELETE FROM rule WHERE id=?").run(id); }
  private mapRule(r: any): RuleRow | undefined { return r && { id: r.id, deviceId: r.device_id, name: r.name, enabled: r.enabled === 1, priority: r.priority, definition: JSON.parse(r.definition_json), version: r.version }; }

  ruleState(ruleId: string): RuleStateRow | undefined {
    const r = this.db.prepare("SELECT * FROM rule_state WHERE rule_id=?").get(ruleId) as any;
    return r && { ruleId: r.rule_id, state: r.state, since: r.since, untilTs: r.until_ts, context: r.context_json ? JSON.parse(r.context_json) : null };
  }
  setRuleState(ruleId: string, state: string, since: number, untilTs: number | null = null, context: unknown = null) {
    this.db.prepare("INSERT INTO rule_state VALUES (?,?,?,?,?) ON CONFLICT(rule_id) DO UPDATE SET state=excluded.state, since=excluded.since, until_ts=excluded.until_ts, context_json=excluded.context_json")
      .run(ruleId, state, since, untilTs, context === null ? null : JSON.stringify(context));
  }
  startRuleRun(ruleId: string, at: number): string { const id = newId(at); this.db.prepare("INSERT INTO rule_run (id, rule_id, started_at) VALUES (?,?,?)").run(id, ruleId, at); return id; }
  endRuleRun(id: string, at: number, outcome: string, reason?: string) { this.db.prepare("UPDATE rule_run SET ended_at=?, outcome=?, reason=? WHERE id=?").run(at, outcome, reason ?? null, id); }
  ruleRuns(ruleId: string, limit = 50) {
    return (this.db.prepare("SELECT * FROM rule_run WHERE rule_id=? ORDER BY started_at DESC LIMIT ?").all(ruleId, limit) as any[]).map((r) => ({ id: r.id, ruleId: r.rule_id, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome, reason: r.reason }));
  }

  // sessions
  openSession(s: { deviceId: string; startTs: number; tempStart?: number; targetTemp?: number; mode?: string; fan?: string; origin?: string; ruleId?: string }): SessionRow {
    const id = newId(s.startTs);
    this.db.prepare("INSERT INTO session (id, device_id, start_ts, temp_start, target_temp, mode, fan, origin, rule_id) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, s.deviceId, s.startTs, s.tempStart ?? null, s.targetTemp ?? null, s.mode ?? null, s.fan ?? null, s.origin ?? null, s.ruleId ?? null);
    return this.session(id)!;
  }
  openSessionOf(deviceId: string): SessionRow | undefined { return this.mapSession(this.db.prepare("SELECT * FROM session WHERE device_id=? AND end_ts IS NULL").get(deviceId)); }
  session(id: string): SessionRow | undefined { return this.mapSession(this.db.prepare("SELECT * FROM session WHERE id=?").get(id)); }
  closeSession(id: string, endTs: number, closedBy: string, tempEnd?: number) { this.db.prepare("UPDATE session SET end_ts=?, closed_by=?, temp_end=? WHERE id=?").run(endTs, closedBy, tempEnd ?? null, id); }
  updateSessionEstimate(id: string, wh: number | null, cost: number | null, method: string | null, basis?: unknown) {
    this.db.prepare("UPDATE session SET energy_wh_est=?, cost_est=?, estimate_method=?, estimate_basis_json=? WHERE id=?").run(wh, cost, method, basis === undefined ? null : JSON.stringify(basis), id);
  }
  sessions(deviceId: string, from: number, to: number): SessionRow[] {
    return (this.db.prepare("SELECT * FROM session WHERE device_id=? AND start_ts<=? AND COALESCE(end_ts, 9007199254740991)>=? ORDER BY start_ts").all(deviceId, to, from) as any[]).map((r) => this.mapSession(r)!);
  }
  private mapSession(r: any): SessionRow | undefined {
    return r && { id: r.id, deviceId: r.device_id, startTs: r.start_ts, endTs: r.end_ts, tempStart: r.temp_start, tempEnd: r.temp_end, targetTemp: r.target_temp, mode: r.mode, fan: r.fan, origin: r.origin, ruleId: r.rule_id,
      closedBy: r.closed_by, energyWhEst: r.energy_wh_est, costEst: r.cost_est, estimateMethod: r.estimate_method };
  }

  // energy
  upsertEnergyDaily(deviceId: string, date: string, wh: number, final: boolean, collectedAt: number, raw?: unknown) {
    this.db.prepare("INSERT INTO energy_daily VALUES (?,?,?,?,?,?) ON CONFLICT(device_id, date) DO UPDATE SET wh=excluded.wh, final=excluded.final, collected_at=excluded.collected_at, raw_json=excluded.raw_json WHERE energy_daily.final=0 OR excluded.final=1")
      .run(deviceId, date, wh, final ? 1 : 0, collectedAt, raw === undefined ? null : JSON.stringify(raw));
  }
  energyDaily(deviceId: string, fromDate: string, toDate: string) {
    return (this.db.prepare("SELECT * FROM energy_daily WHERE device_id=? AND date>=? AND date<=? ORDER BY date").all(deviceId, fromDate, toDate) as any[]).map((r) => ({ date: r.date as string, wh: r.wh as number, final: r.final === 1, collectedAt: r.collected_at as number }));
  }
  upsertEnergyMonthly(deviceId: string, month: string, wh: number, collectedAt: number) {
    this.db.prepare("INSERT INTO energy_monthly VALUES (?,?,?,?) ON CONFLICT(device_id, month) DO UPDATE SET wh=excluded.wh, collected_at=excluded.collected_at").run(deviceId, month, wh, collectedAt);
  }
  energyMonthly(deviceId: string, fromMonth: string, toMonth: string) {
    return (this.db.prepare("SELECT * FROM energy_monthly WHERE device_id=? AND month>=? AND month<=? ORDER BY month").all(deviceId, fromMonth, toMonth) as any[]).map((r) => ({ month: r.month as string, wh: r.wh as number, collectedAt: r.collected_at as number }));
  }
  upsertEnergyHourly(deviceId: string, hourTs: number, wh: number, collectedAt: number) {
    this.db.prepare("INSERT INTO energy_hourly VALUES (?,?,?,?) ON CONFLICT(device_id, hour_ts) DO UPDATE SET wh=excluded.wh, collected_at=excluded.collected_at").run(deviceId, hourTs, wh, collectedAt);
  }

  addEnergySnapshot(deviceId: string, ts: number, date: string, wh: number) {
    this.db.prepare("INSERT OR IGNORE INTO energy_snapshot VALUES (?,?,?,?)").run(deviceId, ts, date, wh);
  }
  energySnapshots(deviceId: string, fromDate: string, toDate: string): { ts: number; date: string; wh: number }[] {
    return this.db.prepare("SELECT ts, date, wh FROM energy_snapshot WHERE device_id=? AND date>=? AND date<=? ORDER BY ts").all(deviceId, fromDate, toDate) as any;
  }

  // sensores externos (consultados por HTTP)
  createSensor(name: string, pollUrl: string, deviceId: string | null, now: number): SensorRow {
    const id = newId(now);
    this.db.prepare("INSERT INTO sensor (id, name, poll_url, device_id, created_at) VALUES (?,?,?,?,?)").run(id, name, pollUrl, deviceId, now);
    return this.sensor(id)!;
  }
  sensor(id: string): SensorRow | undefined { return this.mapSensor(this.db.prepare("SELECT * FROM sensor WHERE id=?").get(id)); }
  sensors(): SensorRow[] { return (this.db.prepare("SELECT * FROM sensor ORDER BY created_at").all() as any[]).map((r) => this.mapSensor(r)!); }
  updateSensor(id: string, p: { name?: string; deviceId?: string | null; pollUrl?: string }) {
    if (p.name !== undefined) this.db.prepare("UPDATE sensor SET name=? WHERE id=?").run(p.name, id);
    if (p.deviceId !== undefined) this.db.prepare("UPDATE sensor SET device_id=? WHERE id=?").run(p.deviceId, id);
    if (p.pollUrl !== undefined) this.db.prepare("UPDATE sensor SET poll_url=? WHERE id=?").run(p.pollUrl, id);
  }
  deleteSensor(id: string) { this.db.prepare("DELETE FROM sensor WHERE id=?").run(id); }
  setSensorReading(id: string, ts: number, temp: number | null, hum: number | null) {
    this.db.prepare("UPDATE sensor SET last_ts=?, last_temp=COALESCE(?, last_temp), last_hum=COALESCE(?, last_hum), last_error=NULL WHERE id=?").run(ts, temp, hum, id);
  }
  setSensorError(id: string, error: string) { this.db.prepare("UPDATE sensor SET last_error=? WHERE id=?").run(error.slice(0, 200), id); }
  insertSensorReading(id: string, ts: number, temp: number | null, hum: number | null) {
    this.db.prepare("INSERT OR REPLACE INTO sensor_reading VALUES (?,?,?,?)").run(id, ts, temp, hum);
  }
  sensorReadings(id: string, from: number, to: number, limit = 5000): { ts: number; temp: number | null; hum: number | null }[] {
    return this.db.prepare("SELECT ts, temp, hum FROM sensor_reading WHERE sensor_id=? AND ts>=? AND ts<=? ORDER BY ts LIMIT ?").all(id, from, to, limit) as any;
  }
  private mapSensor(r: any): SensorRow | undefined { return r && { id: r.id, name: r.name, pollUrl: r.poll_url, deviceId: r.device_id, createdAt: r.created_at, lastTs: r.last_ts, lastTemp: r.last_temp, lastHum: r.last_hum, lastError: r.last_error }; }

  // tariff / goal / settings
  addTariff(validFrom: string, priceMicro: number, note?: string, now = Date.now()) {
    this.db.prepare("INSERT INTO tariff VALUES (?,?,?,?,?) ON CONFLICT(valid_from) DO UPDATE SET price_per_kwh_micro=excluded.price_per_kwh_micro, note=excluded.note").run(newId(now), validFrom, priceMicro, note ?? null, now);
  }
  tariffs() { return (this.db.prepare("SELECT valid_from, price_per_kwh_micro, note FROM tariff ORDER BY valid_from").all() as any[]).map((r) => ({ validFrom: r.valid_from as string, priceMicro: r.price_per_kwh_micro as number, note: r.note as string | null })); }
  setGoal(month: string, budgetCents: number) { this.db.prepare("INSERT INTO goal VALUES (?,?) ON CONFLICT(month) DO UPDATE SET budget_cents=excluded.budget_cents").run(month, budgetCents); }
  goal(month: string): number | undefined { return (this.db.prepare("SELECT budget_cents c FROM goal WHERE month=?").get(month) as { c: number } | undefined)?.c; }
  getSetting<T>(key: string, def: T): T { const r = this.db.prepare("SELECT value_json v FROM setting WHERE key=?").get(key) as { v: string } | undefined; return r ? JSON.parse(r.v) : def; }
  setSetting(key: string, v: unknown) { this.db.prepare("INSERT INTO setting VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(key, JSON.stringify(v)); }
}

/** Retenção e rollups (job diário). Idempotente. */
export interface RetentionConfig { rawEventDays: number; readingDays: number; rollupDays: number }
export const DEFAULT_RETENTION: RetentionConfig = { rawEventDays: 14, readingDays: 90, rollupDays: 730 };

export function runRetention(store: Store, now: number, tz: string, cfg: RetentionConfig = DEFAULT_RETENTION) {
  const db = store.db, DAY = 86_400_000;
  // 1. rollup horário das leituras que serão purgadas (antes de apagar) e das últimas 48 h
  const from = now - Math.max(cfg.readingDays, 2) * DAY;
  const rows = db.prepare("SELECT device_id d, ts, power, target_temp tt, current_temp ct FROM reading WHERE ts>=? ORDER BY device_id, ts").all(from) as { d: string; ts: number; power: number | null; tt: number | null; ct: number | null }[];
  const up = db.prepare(`INSERT INTO rollup_hourly VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(device_id, hour_ts) DO UPDATE SET temp_avg=excluded.temp_avg, temp_min=excluded.temp_min, temp_max=excluded.temp_max, target_avg=excluded.target_avg, minutes_on=excluded.minutes_on, samples=excluded.samples`);
  const HOUR = 3_600_000;
  type Acc = { n: number; sum: number; min: number; max: number; tn: number; tsum: number; samples: number; onMs: number };
  const acc = new Map<string, Acc>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!, next = rows[i + 1];
    const hour = Math.floor(r.ts / HOUR) * HOUR, key = `${r.d}|${hour}`;
    const a = acc.get(key) ?? { n: 0, sum: 0, min: Infinity, max: -Infinity, tn: 0, tsum: 0, samples: 0, onMs: 0 };
    a.samples++;
    if (r.ct !== null) { a.n++; a.sum += r.ct; a.min = Math.min(a.min, r.ct); a.max = Math.max(a.max, r.ct); }
    if (r.tt !== null) { a.tn++; a.tsum += r.tt; }
    if (r.power === 1) { const end = next && next.d === r.d ? Math.min(next.ts, hour + HOUR) : Math.min(now, hour + HOUR); a.onMs += Math.max(0, end - r.ts); }
    acc.set(key, a);
  }
  db.transaction(() => {
    for (const [key, a] of acc) { const [d, h] = key.split("|") as [string, string]; up.run(d, Number(h), a.n ? a.sum / a.n : null, a.n ? a.min : null, a.n ? a.max : null, a.tn ? a.tsum / a.tn : null, Math.round(a.onMs / 60000), a.samples); }
    // 2. purge
    db.prepare("DELETE FROM event_raw WHERE received_at<?").run(now - cfg.rawEventDays * DAY);
    db.prepare("DELETE FROM reading WHERE ts<?").run(now - cfg.readingDays * DAY);
    db.prepare("DELETE FROM rollup_hourly WHERE hour_ts<?").run(now - cfg.rollupDays * DAY);
    db.prepare("DELETE FROM energy_snapshot WHERE ts<?").run(now - cfg.readingDays * DAY);
    db.prepare("DELETE FROM sensor_reading WHERE ts<?").run(now - cfg.readingDays * DAY);
  })();
  db.pragma("wal_checkpoint(TRUNCATE)");
  void tz;
}
