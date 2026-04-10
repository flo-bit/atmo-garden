-- Read-through cache of the community's accent color. The canonical value
-- lives on the `garden.atmo.community/self` record on the community's PDS;
-- we duplicate it here so `getCombinedFeed` (home feed) can JOIN and return
-- each post's accent color without an N+1 getRecord roundtrip per render.
-- The cron tick refreshes this column from the record on every run.
ALTER TABLE communities ADD COLUMN accent_color TEXT;
