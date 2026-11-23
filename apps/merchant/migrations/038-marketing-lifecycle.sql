-- Additive; also initialized idempotently by marketingInit on each store DO.
CREATE TABLE IF NOT EXISTS marketing_settings(id TEXT PRIMARY KEY,config TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_delivery_observations(order_id TEXT PRIMARY KEY,first_seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_checkout_links(cart_id TEXT PRIMARY KEY,checkout_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS marketing_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL);
