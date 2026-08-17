-- 0002_create-welcome
--
-- A guild's welcome message.
--
-- One row per guild, kept forever, replaced whole on every change. There is no
-- second table for the editor panel on purpose: the panel reads and writes this
-- row directly, so a button clicked an hour after a deploy still works and
-- there is no half-finished state to expire, sweep, or reconcile.
--
-- `enabled` is derived from the other two columns by the domain rather than set
-- by hand, so a row can never claim to be greeting people with no channel to
-- greet them in.
--
-- Runs inside a transaction by default. Add the line
--   -- migrate:no-transaction
-- if this migration uses CREATE INDEX CONCURRENTLY or similar.

CREATE TABLE welcome_settings (
  guild_id   text        PRIMARY KEY,
  channel_id text,
  message    text        NOT NULL,
  enabled    boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
