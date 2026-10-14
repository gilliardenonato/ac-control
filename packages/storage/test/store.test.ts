import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, Store } from "../src/index.ts";

const mk = () => { const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrate(db); return new Store(db); };

describe("Store", () => {
  it("migra do zero e é idempotente", () => {
    const db = new Database(":memory:"); migrate(db); migrate(db);
    expect((db.prepare("SELECT count(*) c FROM schema_migrations").get() as any).c).toBe(3);
  });
  it("upsert de device mantém o mesmo id", () => {
    const s = mk(); const a = s.upsertDevice("fake", "x", "AC"); const b = s.upsertDevice("fake", "x", "AC2");
    expect(b.id).toBe(a.id); expect(b.name).toBe("AC2");
  });
  it("só uma sessão aberta por device", () => {
    const s = mk(); const d = s.upsertDevice("fake", "x", "AC");
    s.openSession({ deviceId: d.id, startTs: 1 });
    expect(() => s.openSession({ deviceId: d.id, startTs: 2 })).toThrow(/UNIQUE/);
    s.closeSession(s.openSessionOf(d.id)!.id, 10, "power_off");
    expect(() => s.openSession({ deviceId: d.id, startTs: 11 })).not.toThrow();
  });
  it("idempotencyKey único por device", () => {
    const s = mk(); const d = s.upsertDevice("fake", "x", "AC");
    s.insertCommand({ deviceId: d.id, origin: "manual", idempotencyKey: "k", attributes: { power: true }, now: 1 });
    expect(() => s.insertCommand({ deviceId: d.id, origin: "manual", idempotencyKey: "k", attributes: {}, now: 2 })).toThrow(/UNIQUE/);
  });
  it("energia: dia final não é sobrescrito por dado parcial", () => {
    const s = mk(); const d = s.upsertDevice("fake", "x", "AC");
    s.upsertEnergyDaily(d.id, "2026-10-01", 1000, true, 1);
    s.upsertEnergyDaily(d.id, "2026-10-01", 500, false, 2);
    expect(s.energyDaily(d.id, "2026-10-01", "2026-10-01")[0]!.wh).toBe(1000);
    s.upsertEnergyDaily(d.id, "2026-10-02", 100, false, 1); s.upsertEnergyDaily(d.id, "2026-10-02", 300, false, 2);
    expect(s.energyDaily(d.id, "2026-10-02", "2026-10-02")[0]!.wh).toBe(300);
  });
  it("regra: salvar incrementa versão; deletar remove estado em cascata", () => {
    const s = mk(); const d = s.upsertDevice("fake", "x", "AC");
    const r = s.saveRule({ deviceId: d.id, name: "n", enabled: true, priority: 1, definition: { a: 1 } });
    s.saveRule({ id: r.id, deviceId: d.id, name: "n2", enabled: true, priority: 1, definition: { a: 2 } });
    expect(s.rule(r.id)!.version).toBe(2);
    s.setRuleState(r.id, "IDLE", 1); s.deleteRule(r.id);
    expect(s.ruleState(r.id)).toBeUndefined();
  });
  it("capabilities só grava quando o hash muda", () => {
    const s = mk(); const d = s.upsertDevice("fake", "x", "AC");
    expect(s.saveCapabilities(d.id, "h1", {})).toBe(true); expect(s.saveCapabilities(d.id, "h1", {})).toBe(false); expect(s.saveCapabilities(d.id, "h2", {})).toBe(true);
  });
});

import { runRetention } from "../src/index.ts";
describe("retenção", () => {
  it("faz rollup antes de purgar; é idempotente; respeita janelas", () => {
    const s = mk(); const d = s.upsertDevice("fake", "x", "AC");
    const DAY = 86_400_000, now = Date.parse("2026-06-01T12:00:00Z");
    const old = now - 100 * DAY; // fora dos 90 d
    s.insertReading(d.id, old, { power: true, currentTemp: 26, targetTemp: 23 }, "mqtt");
    s.insertReading(d.id, now - 3 * 3600_000, { power: true, currentTemp: 27, targetTemp: 23 }, "mqtt");
    s.insertReading(d.id, now - 3 * 3600_000 + 1800_000, { power: false, currentTemp: 25, targetTemp: 23 }, "mqtt");
    s.insertEventRaw(d.id, now - 20 * DAY, "mqtt", {}); s.insertEventRaw(d.id, now - 1 * DAY, "mqtt", {});
    runRetention(s, now, "UTC"); runRetention(s, now, "UTC");
    expect(s.readings(d.id, 0, now)).toHaveLength(2);
    expect((s.db.prepare("SELECT count(*) c FROM event_raw").get() as any).c).toBe(1);
    const r = s.db.prepare("SELECT * FROM rollup_hourly WHERE device_id=?").all(d.id) as any[];
    expect(r).toHaveLength(1);
    expect(r[0].minutes_on).toBe(30); expect(r[0].temp_min).toBe(25); expect(r[0].temp_max).toBe(27); expect(r[0].samples).toBe(2);
  });
});
