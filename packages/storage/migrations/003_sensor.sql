-- Sensores externos consultados por HTTP (ex.: ESP32 com DHT servindo JSON em /sensor).
CREATE TABLE sensor (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, poll_url TEXT NOT NULL,
  device_id TEXT REFERENCES device(id) ON DELETE SET NULL,   -- aparelho/ambiente que este sensor representa
  created_at INTEGER NOT NULL, last_ts INTEGER, last_temp REAL, last_hum REAL, last_error TEXT);
CREATE TABLE sensor_reading (
  sensor_id TEXT NOT NULL REFERENCES sensor(id) ON DELETE CASCADE, ts INTEGER NOT NULL, temp REAL, hum REAL,
  PRIMARY KEY (sensor_id, ts)) WITHOUT ROWID;
