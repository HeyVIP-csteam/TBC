-- D1 schema for the account/office/lock/login-failure-counter/IP-access
-- migration off plain KV (see functions/_shared/accountsStore.js).
-- Run this ONCE in the Cloudflare Dashboard: D1 Database > accounts-db > Console tab.
-- Paste the whole thing and click "Execute".

CREATE TABLE IF NOT EXISTS kv (
  key  TEXT PRIMARY KEY,
  data TEXT NOT NULL   -- the exact same JSON string the old KV value used to hold
);
