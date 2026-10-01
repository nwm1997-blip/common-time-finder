CREATE TABLE IF NOT EXISTS meetings (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  dates           TEXT NOT NULL,          -- JSON array of 'YYYY-MM-DD'
  start_min       INTEGER NOT NULL,       -- minutes after midnight
  end_min         INTEGER NOT NULL,
  tz              TEXT NOT NULL,
  created_by      TEXT NOT NULL,          -- Firebase uid
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meetings_created_by ON meetings(created_by);

CREATE TABLE IF NOT EXISTS availability (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  photo      TEXT NOT NULL DEFAULT '',
  slots      TEXT NOT NULL DEFAULT '[]',  -- JSON array of slot indexes
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS availability_user ON availability(user_id);
