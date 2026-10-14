-- Leituras do acumulado "hoje" da LG (atualiza em degraus de ~5–10 min). Permite energia por sessão por diferença do contador.
CREATE TABLE energy_snapshot (
  device_id TEXT NOT NULL REFERENCES device(id), ts INTEGER NOT NULL, date TEXT NOT NULL, wh REAL NOT NULL,
  PRIMARY KEY (device_id, ts)) WITHOUT ROWID;
CREATE INDEX ix_energy_snapshot_date ON energy_snapshot(device_id, date, ts);
