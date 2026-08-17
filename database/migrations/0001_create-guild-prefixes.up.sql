-- 0001_create-guild-prefixes
--
-- A server's own message-command prefix, when it has chosen one.
--
-- A row exists only for a guild that has set a prefix. Clearing one deletes
-- the row rather than nulling the column, so "no row" is the single
-- representation of "use the default" — there is no second way to say it and
-- therefore no way for the two to disagree.
--
-- Runs inside a transaction by default. Add the line
--   -- migrate:no-transaction
-- if this migration uses CREATE INDEX CONCURRENTLY or similar.
--
-- Conventions (docs/conventions.md):
--   - tables are snake_case and plural: guild_prefixes, tickets
--   - primary key is `id`, foreign keys `<singular>_id`
--   - timestamps are `created_at` / `updated_at`, type timestamptz
--   - Discord snowflakes are `text`, not bigint. They are identifiers,
--     never arithmetic, and every API sends and receives them as strings
--   - index what you filter and join on, in this file, now

CREATE TABLE guild_prefixes (
  -- The guild id is the natural key: one prefix per guild, or no row at all.
  -- No surrogate `id` column, because there is nothing else to identify.
  guild_id   text        PRIMARY KEY,
  prefix     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- No secondary index: every read is by primary key. Adding one "just in case"
-- costs a write on every update and answers no query anyone makes.
