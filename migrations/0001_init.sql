-- Generated from the schema export in server.js; keep the two in step.
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  handle TEXT NOT NULL,
  handle_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Field Agent',
  bio TEXT NOT NULL DEFAULT '',
  signature_mode TEXT NOT NULL DEFAULT 'none',
  signature_text TEXT NOT NULL DEFAULT '',
  signature_style TEXT NOT NULL DEFAULT 'classic',
  signature_strokes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_username ON profiles(username);
CREATE TABLE IF NOT EXISTS sync_encryption_keys (
  user_id TEXT PRIMARY KEY,
  key_b64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_documents (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  blob_url TEXT,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS sync_documents_user_updated ON sync_documents(user_id, updated_at);
CREATE TABLE IF NOT EXISTS sync_operations (
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operation_id)
);
CREATE TABLE IF NOT EXISTS google_accounts (
  user_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  picture_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS google_sessions_user ON google_sessions(user_id);
CREATE TABLE IF NOT EXISTS google_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit(created_at);
