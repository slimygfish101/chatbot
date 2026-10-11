-- Members of the announcement list.
CREATE TABLE members (
  phone       TEXT PRIMARY KEY,               -- E.164, e.g. +12125551234
  name        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active', -- active | opted_out | removed
  added_at    TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  welcomed_at TEXT
);
CREATE INDEX members_status ON members(status);

-- Every inbound Telnyx message id we've seen, so a repeated webhook does nothing.
CREATE TABLE processed_messages (
  message_id  TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- One row per blast (or bulk welcome).
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL DEFAULT 'blast', -- blast | welcome
  admin_phone  TEXT,                          -- who gets the summary
  body         TEXT NOT NULL,
  status       TEXT NOT NULL,                 -- queued | sending | done | cancelled
  segments     INTEGER NOT NULL DEFAULT 1,    -- texts per person
  encoding     TEXT NOT NULL DEFAULT 'GSM-7',
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  cap_notice_day TEXT                         -- day we last told the admin about the cap
);
CREATE INDEX jobs_status ON jobs(status, id);

-- Who each blast goes to (snapshotted when the blast is created) and how it went.
CREATE TABLE job_recipients (
  job_id          INTEGER NOT NULL,
  phone           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed | skipped
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  claimed_at      TEXT,
  telnyx_id       TEXT,
  delivery        TEXT,                            -- final carrier status from Telnyx, if reported
  error           TEXT,
  PRIMARY KEY (job_id, phone)
);
CREATE INDEX job_recipients_status ON job_recipients(job_id, status);
CREATE INDEX job_recipients_telnyx ON job_recipients(telnyx_id);

-- Texts sent per day, for MAX_TEXTS_PER_DAY.
CREATE TABLE daily_counts (
  day   TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

-- A simple lock so two runs of the sender never send the same batch.
CREATE TABLE locks (
  name  TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  until INTEGER NOT NULL
);
