-- Community accounts we manage. Each row represents a rookery-hosted
-- account with a secp256k1 WelcomeMat keypair.
--
-- Key storage:
--   secret_key_ciphertext + secret_key_iv — AES-GCM encrypted hex-encoded
--     secp256k1 secret key (32 bytes → 64 hex chars → ~90 bytes encrypted)
--   public_jwk_json — serialized EC public JWK
--   thumbprint — RFC 7638 JWK thumbprint (the account's DPoP identity)
CREATE TABLE communities (
	did TEXT PRIMARY KEY,
	handle TEXT NOT NULL,
	pds TEXT NOT NULL,
	secret_key_ciphertext TEXT NOT NULL,
	secret_key_iv TEXT NOT NULL,
	public_jwk_json TEXT NOT NULL,
	thumbprint TEXT NOT NULL,
	display_name TEXT,
	avatar TEXT,
	description TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_communities_handle ON communities(handle);

-- Cached quote posts (= community submissions).
CREATE TABLE posts (
	uri TEXT PRIMARY KEY,
	cid TEXT NOT NULL,
	community_did TEXT NOT NULL,
	title TEXT NOT NULL,
	quoted_post_uri TEXT NOT NULL,
	quoted_post_cid TEXT,
	author_did TEXT,
	like_count INTEGER DEFAULT 0,
	reply_count INTEGER DEFAULT 0,
	repost_count INTEGER DEFAULT 0,
	indexed_at TEXT NOT NULL,
	last_refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (community_did) REFERENCES communities(did)
);

CREATE INDEX idx_posts_community ON posts(community_did, indexed_at DESC);
CREATE INDEX idx_posts_indexed ON posts(indexed_at DESC);
CREATE INDEX idx_posts_refresh ON posts(last_refreshed_at);

-- Dedup: never create two quote posts for the same (community, quoted post).
CREATE UNIQUE INDEX idx_posts_community_quoted ON posts(community_did, quoted_post_uri);
