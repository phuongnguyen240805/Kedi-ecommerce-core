CREATE TABLE IF NOT EXISTS marketing_subscribers(id TEXT NOT NULL UNIQUE,email TEXT PRIMARY KEY,status TEXT NOT NULL,
 nonce TEXT NOT NULL,created_at INTEGER NOT NULL,confirmed_at INTEGER,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_consent(id TEXT PRIMARY KEY,email TEXT NOT NULL,event TEXT NOT NULL,purpose TEXT NOT NULL,source TEXT NOT NULL,policy_version TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_suppressions(email TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_rates(rate_key TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(rate_key,window));
CREATE TABLE IF NOT EXISTS marketing_jobs(id TEXT PRIMARY KEY,email TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,
 dedupe_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
 due_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,provider_id TEXT UNIQUE,
 delivery_status TEXT,accepted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS marketing_due ON marketing_jobs(state,due_at);
CREATE TABLE IF NOT EXISTS marketing_events(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,event TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_webhook_tokens(token TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_attribution(order_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,model TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_cursors(name TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS marketing_order_lookup ON orders(lower(customer_email),created_at);
CREATE INDEX IF NOT EXISTS marketing_cart_lookup ON carts(lower(customer_email),updated_at);
CREATE INDEX IF NOT EXISTS marketing_recipient_jobs ON marketing_jobs(email,state,updated_at);
CREATE TABLE IF NOT EXISTS feed_offers(sku TEXT PRIMARY KEY,config TEXT NOT NULL,updated_at INTEGER NOT NULL);
