-- Baseline like count captured when the community surfaced the post.
-- "Community lift" = current likes − this baseline. Powers the Hot sort
-- formula so that freshly-submitted viral posts don't dominate on the
-- strength of pre-community engagement.
ALTER TABLE posts ADD COLUMN like_count_at_submission INTEGER;

-- Backfill existing rows: treat "now" as the baseline so they start at
-- zero lift and rank at the bottom of Hot. Any new likes they earn
-- post-migration will count as genuine community lift.
UPDATE posts SET like_count_at_submission = like_count;
