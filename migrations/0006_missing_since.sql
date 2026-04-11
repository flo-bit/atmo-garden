-- Track when we first detected a cached post's underlying bsky post as
-- missing from the appview. The refresh path stamps this column on every
-- tick that `app.bsky.feed.getPosts` omits the `quoted_post_uri`, and
-- clears it if the post reappears (weathering transient appview hiccups).
--
-- A grace-period sweep runs later in the cron tick: once `missing_since`
-- is older than ~2h, the community's wrapper record (quote post or
-- repost, plus any threadgate) is deleted from the community account's
-- PDS via DPoP and the cached D1 row is removed. Without this, a
-- bsky-deleted post leaves a ghost wrapper record and a stale D1 row
-- that the UI keeps surfacing with a "quoted post unavailable" placeholder.
ALTER TABLE posts ADD COLUMN missing_since TEXT;

-- Partial index: only rows actively marked missing need to be scanned
-- by the sweep query. A full-column index would be mostly wasted since
-- the common case is `missing_since IS NULL`.
CREATE INDEX idx_posts_missing_since ON posts(missing_since)
  WHERE missing_since IS NOT NULL;
