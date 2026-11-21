-- The commons: what residents put where others (and their caretakers) can see it.
-- One SQLite file (WAL), opened by each resident's tool server and by the
-- management web app. Both apply this file with CREATE ... IF NOT EXISTS; change
-- the schema here only, with a migration when a column changes.
--
-- Two different questions are kept apart on purpose:
--   "did it work"       -> skill_runs (mechanical: did the declared expectation hold)
--   "is it worth having" -> reuse by residents other than the author, and reviews
--                           (a human or the caretaker says keep or reject, with a reason)

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;

-- A named routine written by a resident: JavaScript run by the tool server against the body tools.
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                 -- snake_case, 3..40 chars
  author TEXT NOT NULL,                      -- resident name
  description TEXT NOT NULL,                 -- one or two sentences: what it does and when to use it
  code TEXT NOT NULL,                        -- body of an async function
  params_json TEXT NOT NULL DEFAULT '{}',    -- { name: "what it means" }
  expect_json TEXT,                          -- mechanical check after a run, e.g. {"gain":{"minecraft:stick":4}}
  -- draft: only its author sees and runs it. verified: passed its check at least once; everyone
  -- sees it, marked unreviewed. curated / rejected: set by a reviewer only.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'curated', 'rejected')),
  version INTEGER NOT NULL DEFAULT 1,        -- bumped when the code changes (which also returns it to draft)
  created_at INTEGER NOT NULL,               -- unix ms
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id INTEGER PRIMARY KEY,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  resident TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,                       -- 1 when it ran to the end without error, timeout or abort
  check_ok INTEGER,                          -- 1/0 for the expectation, NULL when the skill declares none
  error TEXT,
  args_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS skill_runs_by_skill ON skill_runs(skill_id, started_at);

-- Prose a resident offers to the others. Nobody else sees it until a reviewer
-- curates it: one resident's mistaken belief must not become everyone's.
CREATE TABLE IF NOT EXISTS shared_notes (
  id INTEGER PRIMARY KEY,
  author TEXT NOT NULL,
  topic TEXT NOT NULL,
  text TEXT NOT NULL,                        -- at most 600 chars
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'curated', 'rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A reviewer's judgement of a skill or a shared note.
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'note')),
  target_id INTEGER NOT NULL,
  reviewer TEXT NOT NULL,                    -- a person's name, or 'caretaker'
  verdict TEXT NOT NULL CHECK (verdict IN ('keep', 'reject', 'comment')),
  text TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_by_target ON reviews(kind, target_id);

-- A resident's own one-line verdict after using someone's skill or acting on a
-- curated note: a third signal beside "did it work" and "a reviewer says keep".
-- One row per resident per target; a later verdict replaces the earlier one.
CREATE TABLE IF NOT EXISTS feedback (
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'note')),
  target_id INTEGER NOT NULL,
  resident TEXT NOT NULL,
  worked INTEGER NOT NULL,                   -- 1 "worked well for me", 0 "did not work for me"
  text TEXT NOT NULL DEFAULT '',             -- optional, at most 120 chars: when or why
  version INTEGER,                           -- the skill version the verdict was about (NULL for notes)
  at INTEGER NOT NULL,
  PRIMARY KEY (kind, target_id, resident)
) WITHOUT ROWID;

-- Where each resident was, sampled by the web app while its client is up (map trails).
CREATE TABLE IF NOT EXISTS positions (
  resident TEXT NOT NULL,
  at INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  dimension TEXT NOT NULL,
  health REAL, food INTEGER,
  PRIMARY KEY (resident, at)
) WITHOUT ROWID;
