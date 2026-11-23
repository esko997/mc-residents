-- The commons: what residents put where others (and their caretakers) can see it.
-- One SQLite file (WAL), opened by the hub and its central caretaker jobs.
-- The hub applies CREATE ... IF NOT EXISTS; residents access stores over HTTP.
-- Change the schema here only, with a migration when a column changes.
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
-- dimension is the client's id (minecraft:the_nether); sky is the sky light 0-15 at the
-- body's feet, NULL when unknown (rows from before it was recorded). Older databases get
-- sky from migratePositions (src/positions.ts), which keeps their rows.
CREATE TABLE IF NOT EXISTS positions (
  resident TEXT NOT NULL,
  at INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  dimension TEXT NOT NULL,
  health REAL, food INTEGER,
  sky INTEGER,
  PRIMARY KEY (resident, at)
) WITHOUT ROWID;

-- Voluntary agreements. revision covers every transition; accepted_revision is
-- cleared whenever terms change. Completion and confirmation are human reports.
CREATE TABLE IF NOT EXISTS collaborations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'offer')),
  sender TEXT NOT NULL COLLATE NOCASE,
  recipient TEXT COLLATE NOCASE,              -- NULL is public, until someone volunteers
  project TEXT,
  terms TEXT NOT NULL,
  proposer TEXT NOT NULL COLLATE NOCASE,
  revision INTEGER NOT NULL DEFAULT 1,
  accepted_revision INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'reported', 'confirmed', 'declined', 'withdrawn')),
  evidence TEXT,
  evidence_source TEXT,
  confirmation TEXT,
  confirmation_source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collaborations_pending ON collaborations(status, updated_at);
CREATE TABLE IF NOT EXISTS collaboration_history (
  id INTEGER PRIMARY KEY,
  collaboration_id INTEGER NOT NULL REFERENCES collaborations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collaboration_history_target ON collaboration_history(collaboration_id, id);

-- These are reported facilities, not machine-verified world prerequisites.
-- Observers cannot change the steward's access terms by reporting new stock.
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  purpose TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  dimension TEXT NOT NULL,
  steward TEXT NOT NULL COLLATE NOCASE,
  access_terms TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS facility_observations (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  facility_revision INTEGER NOT NULL,
  observer TEXT NOT NULL,
  condition TEXT NOT NULL,
  certainty TEXT NOT NULL CHECK (certainty IN ('observed', 'uncertain')),
  source TEXT NOT NULL,
  stock_json TEXT,
  observed_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS facility_observations_latest ON facility_observations(facility_id, observed_at DESC, id DESC);

-- Refusing a public invitation is personal: it must not close it for everyone.
CREATE TABLE IF NOT EXISTS collaboration_declines (
  collaboration_id INTEGER NOT NULL REFERENCES collaborations(id) ON DELETE CASCADE,
  resident TEXT NOT NULL COLLATE NOCASE,
  revision INTEGER NOT NULL,
  PRIMARY KEY (collaboration_id, resident)
) WITHOUT ROWID;

-- Guide misses and corrections; caretaker references are never tested skills.
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id INTEGER PRIMARY KEY,
  normalized_question TEXT NOT NULL,
  question TEXT NOT NULL,
  scope TEXT NOT NULL,
  target TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','researching','published','unavailable')),
  occurrences INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  published_revision INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(normalized_question, scope)
);
CREATE INDEX IF NOT EXISTS knowledge_gaps_due ON knowledge_gaps(status, next_attempt_at, lease_until);
CREATE TABLE IF NOT EXISTS knowledge_requests (
  gap_id INTEGER NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
  resident TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  occurrences INTEGER NOT NULL DEFAULT 1,
  seen_revision INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY(gap_id, resident, project)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS knowledge_feedback (
  id INTEGER PRIMARY KEY,
  gap_id INTEGER NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  resident TEXT NOT NULL,
  target TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('unhelpful','inaccurate')),
  detail TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_references (
  gap_id INTEGER NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  answer TEXT NOT NULL,
  prerequisites_json TEXT NOT NULL,
  controls_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  caveats TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  model TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY(gap_id, revision)
) WITHOUT ROWID;

-- Body capabilities a guide needs but no resident tool provides: the maintainers' queue,
-- separate from knowledge research. A blocking report on a gap's current revision stops
-- research of that revision until maintainers provide the capability or a resident corrects it.
CREATE TABLE IF NOT EXISTS capability_gaps (
  id INTEGER PRIMARY KEY,
  normalized_capability TEXT NOT NULL UNIQUE,
  capability TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','provided','declined')),
  occurrences INTEGER NOT NULL DEFAULT 1,
  resolution TEXT NOT NULL DEFAULT '',
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  resolved_at INTEGER
);
-- gap_id/revision 0: a resident's report not tied to a researched reference.
CREATE TABLE IF NOT EXISTS capability_reports (
  capability_id INTEGER NOT NULL REFERENCES capability_gaps(id) ON DELETE CASCADE,
  gap_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  reporter TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0 CHECK(blocking IN (0,1)),
  needed_for TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  PRIMARY KEY(capability_id, gap_id, revision, reporter)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS capability_reports_gap ON capability_reports(gap_id, revision);
-- Tool names each resident's tool server actually exposes, so research names only real controls.
CREATE TABLE IF NOT EXISTS resident_tools (
  name TEXT NOT NULL,
  resident TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY(name, resident)
) WITHOUT ROWID;

-- Hub-owned places; original JSON is imported once without altering the source.
CREATE TABLE IF NOT EXISTS shared_places (
  name TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resident_api_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) WITHOUT ROWID;

-- Accepted alarms: durable rate-limit buckets and hub Activity history.
CREATE TABLE IF NOT EXISTS resident_alarms (
  id INTEGER PRIMARY KEY,
  sender TEXT NOT NULL COLLATE NOCASE,
  bucket TEXT NOT NULL,
  at INTEGER NOT NULL,
  event_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resident_alarms_rate ON resident_alarms(sender,bucket,at DESC);
CREATE INDEX IF NOT EXISTS resident_alarms_time ON resident_alarms(at);

-- Server bridge queries (observer-ingest.ts writes, routes/server-data.ts reads; hub only). Times are the
-- server's clock (epoch ms) as the bridge reported them; received_at is the hub's. `run` is the bridge's start
-- time: its ring sequence numbers and in-memory counts restart with it.
CREATE TABLE IF NOT EXISTS server_ingest_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- What the hub knows it did not receive: ring overwritten before a read, cells evicted, bridge restarts.
CREATE TABLE IF NOT EXISTS server_ingest_gaps (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, run INTEGER NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS server_ingest_gaps_at ON server_ingest_gaps(at);
-- Statistics: one row per stored save of a resident's stats file; values only when they changed.
CREATE TABLE IF NOT EXISTS server_stat_snapshots (
  resident TEXT NOT NULL, saved_at INTEGER NOT NULL, received_at INTEGER NOT NULL, status TEXT NOT NULL,
  entries INTEGER NOT NULL, changed INTEGER NOT NULL, complete INTEGER NOT NULL,
  PRIMARY KEY(resident, saved_at)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS server_stat_values (
  resident TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, saved_at INTEGER NOT NULL, value INTEGER NOT NULL,
  PRIMARY KEY(resident, type, key, saved_at)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS server_stat_latest (
  resident TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL, saved_at INTEGER NOT NULL,
  PRIMARY KEY(resident, type, key)
) WITHOUT ROWID;
-- Advancements: loaded definitions with a display, each resident's progress, and every achieved criterion's time.
CREATE TABLE IF NOT EXISTS server_advancement_catalog (
  id TEXT PRIMARY KEY, title TEXT, frame TEXT, hidden INTEGER NOT NULL, criteria INTEGER NOT NULL,
  requirements INTEGER NOT NULL, parent TEXT, built_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS server_advancements (
  resident TEXT NOT NULL, id TEXT NOT NULL, done INTEGER NOT NULL, criteria_done INTEGER NOT NULL, criteria_total INTEGER,
  first_seen_at INTEGER NOT NULL, done_at INTEGER, saved_at INTEGER NOT NULL,
  PRIMARY KEY(resident, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS server_advancement_criteria (
  resident TEXT NOT NULL, id TEXT NOT NULL, criterion TEXT NOT NULL, achieved_at INTEGER,
  PRIMARY KEY(resident, id, criterion)
) WITHOUT ROWID;
-- Block place/break by residents: recent detail (may skip under bursts) and complete per-chunk hourly counts.
CREATE TABLE IF NOT EXISTS server_block_changes (
  run INTEGER NOT NULL, seq INTEGER NOT NULL, resident TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('place','break')),
  dimension TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL, block TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(run, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS server_block_changes_at ON server_block_changes(at);
CREATE INDEX IF NOT EXISTS server_block_changes_resident ON server_block_changes(resident, at);
CREATE TABLE IF NOT EXISTS server_block_hours (
  run INTEGER NOT NULL, resident TEXT NOT NULL, dimension TEXT NOT NULL, chunk_x INTEGER NOT NULL, chunk_z INTEGER NOT NULL,
  hour INTEGER NOT NULL, placed INTEGER NOT NULL, broken INTEGER NOT NULL, kinds_json TEXT NOT NULL,
  other_placed INTEGER NOT NULL, other_broken INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  PRIMARY KEY(run, resident, dimension, chunk_x, chunk_z, hour)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS server_block_hours_hour ON server_block_hours(hour);
-- Changes counted without a position because the bridge's cell table was full.
CREATE TABLE IF NOT EXISTS server_block_overflow (
  run INTEGER NOT NULL, resident TEXT NOT NULL, hour INTEGER NOT NULL, placed INTEGER NOT NULL, broken INTEGER NOT NULL,
  PRIMARY KEY(run, resident, hour)
) WITHOUT ROWID;
-- Item count changes in registered containers; `resident` is the nearest configured resident within reach (evidence, not proof).
CREATE TABLE IF NOT EXISTS server_container_flows (
  run INTEGER NOT NULL, seq INTEGER NOT NULL, facility TEXT NOT NULL, at INTEGER NOT NULL, since_at INTEGER NOT NULL,
  continuous INTEGER NOT NULL, deltas_json TEXT NOT NULL, deltas_truncated INTEGER NOT NULL, uncertain_json TEXT NOT NULL,
  attribution TEXT NOT NULL, resident TEXT, nearby_json TEXT NOT NULL,
  PRIMARY KEY(run, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS server_container_flows_at ON server_container_flows(at);
CREATE INDEX IF NOT EXISTS server_container_flows_facility ON server_container_flows(facility, at);

-- Book catalogue (library.ts, library-scan.ts; hub only; migrated from the first one-row-per-copy shape by
-- migrateLibrary in library.ts). A book is one edition: content_hash is the server bridge's resident-book-v1 hash of
-- kind, title, author, generation and pages, so a shelf read names it exactly; text_key (title, author, pages) groups
-- the editions of one text (an original and its copies). Pages are what the server bridge or a resident's body read
-- from the item, never typed; they stay null until read (the bridge's shelf list carries no pages).
CREATE TABLE IF NOT EXISTS library_books (
  id INTEGER PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('written', 'writable')),
  title TEXT, author TEXT, generation INTEGER,
  page_count INTEGER NOT NULL,
  text_key TEXT, pages_json TEXT, text TEXT,
  -- Who read the pages: 'server' or a resident's name; text_failed_at: the last server read of them that failed.
  text_by TEXT, text_failed_at INTEGER,
  subjects_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  -- The resident who gave it subjects or a note (book_register); null while only the server has seen it.
  registrant TEXT COLLATE NOCASE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS library_books_text ON library_books(text_key);
-- One copy of a book at one place. source 'server': standing on a chiseled bookshelf or lectern where the server
-- bridge saw it (slot as it saw it); only the bridge's read of that very position marks it gone, and a position it
-- could not read changes nothing. source 'resident': where a resident said it is (a chest, a room the server does not
-- list); their word, until the server sees the same book at the same place and takes the copy over.
CREATE TABLE IF NOT EXISTS library_copies (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('server', 'resident')),
  dimension TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
  slot INTEGER,
  holder TEXT,
  state TEXT NOT NULL CHECK (state IN ('here', 'gone')),
  -- server: the last time the bridge saw it there; resident: when it was reported there, and by whom.
  seen_at INTEGER NOT NULL, seen_by TEXT NOT NULL,
  -- The bridge's last read of this position and, when that read could not tell (unloaded, no_level, error), why.
  checked_at INTEGER, check_status TEXT,
  gone_at INTEGER, gone_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS library_copies_place ON library_copies(dimension, x, y, z);
CREATE INDEX IF NOT EXISTS library_copies_book ON library_copies(book_id, state);
-- Dated, never rewritten: residents' descriptions and reports, and the server's sightings: a copy first seen at a
-- place (server_seen), seen without it (server_gone), or its shelf gone (shelf_gone).
CREATE TABLE IF NOT EXISTS library_observations (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('registered', 'found', 'missing', 'edited', 'server_seen', 'server_gone', 'shelf_gone')),
  observer TEXT NOT NULL,
  x INTEGER, y INTEGER, z INTEGER, dimension TEXT, slot INTEGER,
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS library_observations_book ON library_observations(book_id, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS library_observations_at ON library_observations(at);

-- Residents' online/offline, dimension changes and deaths as the server bridge reported them (records-ingest.ts).
-- `at` is this hub's clock (the bridge's time shifted by the reply's clock offset). Kept for history.
CREATE TABLE IF NOT EXISTS history_server_events (
  at INTEGER NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, resident TEXT NOT NULL, detail TEXT,
  PRIMARY KEY (at, seq, type, resident)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS history_server_events_resident ON history_server_events(resident, at);
