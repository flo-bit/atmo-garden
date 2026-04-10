-- Cached follower count for each community. Refreshed by the cron tick from
-- `app.bsky.actor.getProfile.followersCount`. Stored locally so the
-- /communities page can ORDER BY without an N+1 appview hit per request.
ALTER TABLE communities ADD COLUMN followers_count INTEGER;
