CREATE TABLE IF NOT EXISTS history_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  device_id TEXT NOT NULL,
  device_name TEXT,
  event_type TEXT NOT NULL,
  title TEXT,
  url TEXT,
  command TEXT,
  status TEXT,
  source TEXT,
  extra_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_device_time
ON history_logs (device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_history_event_time
ON history_logs (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_history_time
ON history_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT,
  status TEXT,
  live_on INTEGER DEFAULT 0,
  current_title TEXT,
  current_url TEXT,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  extra_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen
ON devices (last_seen DESC);
