-- Users and invitations (RBAC). No password and no credential of any kind: an identity is the hash of the Access email claim.
-- admin_principals holds principals registered in the admin (none until an invitation is accepted, which needs the Cloudflare Access policy
-- widened by the lead); the identities on the Access allowlist are owners by configuration and are not rows here.
-- Addresses are never stored: invitee_hash and the principal id are SHA-256 of the lowercased address.
CREATE TABLE IF NOT EXISTS admin_principals (
  id          TEXT PRIMARY KEY CHECK (length(id) = 64),
  role        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL CHECK (length(created_by) = 64)
);

CREATE TABLE IF NOT EXISTS admin_invitations (
  id            TEXT PRIMARY KEY,
  invitee_hash  TEXT NOT NULL CHECK (length(invitee_hash) = 64),
  role          TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'revoked', 'accepted', 'expired')),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL CHECK (length(created_by) = 64),
  revoked_at    TEXT
);
-- one pending invitation per invitee: a repeat is a conflict, not a second row
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_invitations_pending ON admin_invitations(invitee_hash) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_admin_invitations_state ON admin_invitations(state, created_at);
