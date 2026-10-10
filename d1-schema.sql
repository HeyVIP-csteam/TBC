-- D1 schema for the "TG Reply Threads" feature.
-- Run this ONCE in the Cloudflare Dashboard: D1 Database > inr-ticket-threads > Console tab.
-- Paste the whole thing and click "Execute".

CREATE TABLE IF NOT EXISTS threads (
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL   -- the full thread record as JSON (same shape KV used to store)
);

CREATE TABLE IF NOT EXISTS message_index (
  chat_id    TEXT    NOT NULL,
  message_id INTEGER NOT NULL,
  thread_id  TEXT    NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_index_thread ON message_index(thread_id);

-- 2026-10-10 — sidebar list table for TG Reply Threads.
-- You do NOT need to run this by hand: functions/_shared/threadList.js
-- creates these automatically (CREATE ... IF NOT EXISTS) the first time
-- the site touches each country's database, then backfills them in the
-- background. Kept here only as reference / for a manual re-create.
CREATE TABLE IF NOT EXISTS thread_list (
  id            TEXT PRIMARY KEY,
  module        TEXT,
  module_name   TEXT,
  icon          TEXT,
  accent        TEXT,
  brand         TEXT,
  brand_id      TEXT,
  title         TEXT,
  submitter     TEXT,
  submitted_at  TEXT,
  last_activity TEXT,
  solved        INTEGER NOT NULL DEFAULT 0,
  solved_at     TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  reply_count   INTEGER NOT NULL DEFAULT 0,
  search_text   TEXT
);
CREATE INDEX IF NOT EXISTS idx_thread_list_activity ON thread_list (deleted, last_activity);
CREATE TABLE IF NOT EXISTS thread_list_meta (k TEXT PRIMARY KEY, v TEXT);
