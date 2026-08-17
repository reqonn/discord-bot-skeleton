-- Reverts 0001_create-guild-prefixes.
-- Delete this file if the change cannot be safely reverted; the runner
-- will then refuse to roll it back rather than doing so incorrectly.

DROP TABLE guild_prefixes;
