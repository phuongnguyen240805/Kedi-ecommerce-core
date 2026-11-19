CREATE TABLE IF NOT EXISTS ucp_payment_attempts (
 session_id TEXT PRIMARY KEY, request_json TEXT NOT NULL,
 stripe_session_id TEXT UNIQUE, stripe_url TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_receipts (
 provider TEXT NOT NULL, external_id TEXT NOT NULL, order_id TEXT NOT NULL,
 amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(provider,external_id)
);
CREATE TABLE IF NOT EXISTS payment_outbox (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL, event TEXT NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
 UNIQUE(order_id,event)
);
