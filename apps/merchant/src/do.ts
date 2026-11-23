import {FULFILLMENT_SCHEMA,prepareCheckoutFulfillment,type FulfillmentConfig} from './lib/checkout-fulfillment';
import {beginCodPayment} from './lib/checkout-payments';
import {expireOpenCarts,repairLegacyReservationDeficits} from './lib/cart-maintenance';
import {ensureCartItemCurrency,ensureOrderCheckoutSchema} from './lib/cart-schema';
import {STOREFRONT_MIGRATION_SCHEMA,importStorefrontCatalog,provisionStorefrontAccess} from './lib/storefront-migration';
import {beginBankPayment,verifyBankPayment,closeBankPayment} from './lib/checkout-payments';
import {recoverCheckoutMarketing} from './lib/checkout-marketing';
import {saveCheckoutCarrier} from './lib/checkout-carrier';
import {checkoutReadiness} from './lib/checkout-readiness';
import {ShippingError} from './lib/smart-shipping';
import {CHECKOUT_SCHEMA,checkoutInput,checkoutRead,checkoutSave,checkoutCommand,checkoutCancel,type CheckoutInput as RetailCheckoutInput} from './lib/checkout-core';
import {changeCheckoutPayment} from './lib/checkout-payment-change';
import {EXPERIMENT_SCHEMA,createExperiment,marketingRfm,experimentReport} from './lib/marketing-admin';
import * as shippingFlow from './lib/shipping-workflow';
/**
 * MIT License
 *
 * Copyright (c) 2025 ygwyg
 * Copyright (c) 2026 Ronan Le Meillat - SCTG Development
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { DurableObject } from 'cloudflare:workers';
import { UCP_PAYMENT_SCHEMA, beginUcpPayment, attachUcpPayment, expireUcpPayment, settleUcpPayment, type SettlementInput } from './lib/ucp-payment';
import {POD_SCHEMA,approvePodArtwork,reviewPodArtwork,savePodMappingDraft,podQuotePlan,storePodQuote,checkoutPodQuote,claimPodFulfillment,finishPodFulfillment,type PodQuoteInput} from './lib/pod-core';
import {POD_V2_SCHEMA,podV2Command,type PodV2Command} from './lib/pod-v2-store';
import {MARKETING_SCHEMA,subscribeMarketing,confirmMarketing,unsubscribeMarketing,planMarketing,claimMarketing,marketingEligible,finishMarketing,recordMarketingEvent,type SubscriptionInput} from './lib/marketing-core';
import {FEED_SCHEMA,feedSnapshot,putFeedOffer,type FeedOffer} from './lib/product-feeds';
import {SHOPPING_SCHEMA,consumeShopping,allowShoppingAi,type ShoppingSelection} from './lib/shopping';
import { STOREFRONT_CONTENT_SCHEMA } from './lib/storefront-content';
import { CUSTOMER_SESSION_SCHEMA } from './lib/customer-sessions';
import { PANCAKE_SCHEMA, acquirePosLease, applyPosSnapshot, applyPosStock, finishPosError } from './lib/pancake-store';
import type { PancakeSnapshot } from './lib/pancake-source';
import { INTEGRATION_SCHEMA, integrationState, type StateCommand } from './integrations/ctxlayer/store';
import { beginMcpRun, commitMcpRun, failMcpRun, type RunContext } from './integrations/pancake/sync-runs';
import {SHIPPING_SCHEMA,shippingResult,beginShippingQuote,loadShippingCart,storeShippingQuote,selectShippingQuote,readShippingSelection,clearShippingSelection} from './lib/shipping-store';
import type {StoredShippingQuote} from './lib/smart-shipping';
import {ensureSchemaObjects, ensureStoreThemeDefaults, ensureLegacyRoutingColumns} from './lib/sql-schema';
import {authorizeShipment,claimShipment,markShipmentAttempt,finishShipment,type ShipmentResult} from './lib/commerce-shipment-store';
import {COMMERCE_SCHEMA,replayCheckout,confirmCheckout,receipt,recordEvidence,updateFulfillment,claimOutbox,finishOutbox,markCreateAttempt,cancelPendingOrder,resolveBankException,bankResolutionInput,type CheckoutInput,type CheckoutConfig,type EvidenceInput,fulfillmentInput} from './lib/commerce-core';
import {SERVICE_SCHEMA,serviceActionAccess,assertLegacyResolution,expireServiceHold,reconcileServicePayment,adjustmentInput,recordAddressAdjustment,serviceNotificationClaim,serviceNotificationFinish,serviceRecovery,storeServiceEvidence,readServiceEvidence,serviceDetail,serviceQueue,serviceSnapshot,createServiceRequest,decideServiceRequest,createRefund,recordRefundResult,startActionSession,verifyActionSession,assertActionSession,assertNoOpenChanges,storeAddressQuote,requestInput,decisionInput,refundInput,refundResultInput} from './lib/commerce-service';
import type {z} from 'zod';

export interface MerchantEnv {
  MERCHANT: DurableObjectNamespace<MerchantDO>;
  IMAGES?: R2Bucket;
  IMAGES_URL?: string;
  STORE_NAME?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export type WSEventType =
  | 'cart.updated'
  | 'cart.checked_out'
  | 'order.created'
  | 'order.updated'
  | 'order.shipped'
  | 'order.refunded'
  | 'inventory.updated'
  | 'inventory.low';

export interface WSEvent {
  type: WSEventType;
  data: unknown;
  timestamp: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('public', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- MULTI-REGION FOUNDATIONAL TABLES (must be before carts/orders)
-- ============================================================

CREATE TABLE IF NOT EXISTS currencies (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT '$',
  decimal_places INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS countries (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  country_name TEXT NOT NULL,
  language_code TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tax_rates (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  country_code TEXT, -- ISO 3166-1 alpha-2 (e.g., 'FR', 'US'). NULL means fallback for all.
  tax_code TEXT,     -- e.g., 'txcd_99999999'. NULL means default rate.
  rate_percentage REAL NOT NULL, -- e.g., 20.0 for 20%
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state TEXT,
  postal_code TEXT NOT NULL,
  country_code TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- SHIPPING CLASSES (product-specific transport constraints)
-- ============================================================

CREATE TABLE IF NOT EXISTS shipping_classes (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  resolution  TEXT NOT NULL DEFAULT 'exclusive'
              CHECK (resolution IN ('exclusive', 'additive')),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'inactive')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shipping_rates (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  max_weight_g INTEGER,
  min_delivery_days INTEGER,
  max_delivery_days INTEGER,
  tax_code TEXT,
  tax_inclusive INTEGER NOT NULL DEFAULT 0,
  shipping_class_id TEXT REFERENCES shipping_classes(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shipping_rate_prices (
  id TEXT PRIMARY KEY,
  shipping_rate_id TEXT NOT NULL REFERENCES shipping_rates(id) ON DELETE CASCADE,
  currency_id TEXT NOT NULL REFERENCES currencies(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(shipping_rate_id, currency_id)
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  currency_id TEXT NOT NULL REFERENCES currencies(id),
  tax_inclusive INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS region_countries (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  country_id TEXT NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  PRIMARY KEY (region_id, country_id)
);

CREATE TABLE IF NOT EXISTS region_warehouses (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  PRIMARY KEY (region_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS region_shipping_rates (
  region_id TEXT NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  shipping_rate_id TEXT NOT NULL REFERENCES shipping_rates(id) ON DELETE CASCADE,
  PRIMARY KEY (region_id, shipping_rate_id)
);

CREATE TABLE IF NOT EXISTS warehouse_inventory (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  on_hand INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sku, warehouse_id)
);

CREATE TABLE IF NOT EXISTS warehouse_inventory_logs (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('restock', 'correction', 'damaged', 'return', 'sale', 'release')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- CORE PRODUCT TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  image_url TEXT,
  shipping_class_id TEXT REFERENCES shipping_classes(id),
  vendor TEXT,
  tags TEXT,
  handle TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft')),
  review_count   INTEGER NOT NULL DEFAULT 0,
  average_rating REAL    NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  weight_g INTEGER NOT NULL DEFAULT 0,
  dims_cm TEXT,
  requires_shipping INTEGER NOT NULL DEFAULT 1,
  barcode TEXT,
  compare_at_price_cents INTEGER,
  tax_code TEXT,
  image_url TEXT,
  thumbnail_url TEXT,
  shipping_class_id TEXT REFERENCES shipping_classes(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS variant_prices (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  currency_id TEXT NOT NULL REFERENCES currencies(id) ON DELETE CASCADE,
  price_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(variant_id, currency_id)
);

CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  on_hand INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_logs (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('restock', 'correction', 'damaged', 'return', 'sale', 'release')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- CARTS & ORDERS (now safe - regions/warehouses exist)
-- ============================================================

CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out', 'expired')),
  customer_email TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  region_id TEXT,
  stripe_checkout_session_id TEXT,
  discount_code TEXT,
  discount_id TEXT,
  discount_amount_cents INTEGER DEFAULT 0,
  shipping_rate_id TEXT,
  shipping_cents INTEGER DEFAULT 0,
  locale TEXT NOT NULL DEFAULT 'en-US',
  -- GAP-01: Shipping address fields
  shipping_name TEXT,
  shipping_line1 TEXT,
  shipping_line2 TEXT,
  shipping_city TEXT,
  shipping_state TEXT,
  shipping_postal_code TEXT,
  shipping_country TEXT,
  billing_same_as_shipping INTEGER DEFAULT 1,
  taxes_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id),
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD'
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending', 'paid', 'processing', 'shipped', 'delivered', 'refunded', 'canceled')),
  customer_email TEXT NOT NULL,
  region_id TEXT,
  warehouse_id TEXT,
  shipping_name TEXT,
  shipping_phone TEXT,
  ship_to TEXT,
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  shipping_rate_id TEXT,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  discount_code TEXT,
  discount_id TEXT,
  discount_amount_cents INTEGER DEFAULT 0,
  tracking_number TEXT,
  tracking_url TEXT,
  shipped_at TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  taxes_json TEXT,
  viewtoken TEXT,
  viewtoken_issued_at TEXT,
  confirmationemailsentat TEXT,
  confirmationemaillasterror TEXT,
  confirmationemailupdatedat TEXT,
  locale TEXT NOT NULL DEFAULT 'en-US',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discounts (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('percentage', 'fixed_amount')),
  value INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  min_purchase_cents INTEGER DEFAULT 0,
  max_discount_cents INTEGER,
  starts_at TEXT,
  expires_at TEXT,
  usage_limit INTEGER,
  usage_limit_per_customer INTEGER DEFAULT 1,
  usage_count INTEGER NOT NULL DEFAULT 0,
  stripe_coupon_id TEXT,
  stripe_promotion_code_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  stripe_refund_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  reason TEXT CHECK(reason IN ('duplicate', 'fraudulent', 'requested_by_customer')),
  notes TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discount_usage (
  id TEXT PRIMARY KEY,
  discount_id TEXT NOT NULL REFERENCES discounts(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  customer_email TEXT NOT NULL,
  discount_amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  password_hash TEXT,
  email_verified_at TEXT,
  auth_provider TEXT,
  auth_provider_id TEXT,
  accepts_marketing INTEGER DEFAULT 0,
  locale TEXT DEFAULT 'en',
  metadata TEXT,
  order_count INTEGER DEFAULT 0,
  total_spent_cents INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_order_at TEXT
);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT,
  is_default INTEGER DEFAULT 0,
  name TEXT,
  company TEXT,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  state TEXT,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT UNIQUE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  response_code INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_authorizations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  customer_email TEXT,
  magic_token_hash TEXT,
  magic_expires_at TEXT,
  code_hash TEXT,
  code_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorized', 'used', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  access_token_hash TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ucp_checkout_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'incomplete',
  currency TEXT NOT NULL,
  line_items TEXT NOT NULL,
  buyer TEXT,
  totals TEXT NOT NULL,
  messages TEXT,
  payment_instruments TEXT,
  stripe_session_id TEXT,
  order_id TEXT,
  order_number TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_variants_sku ON variants(sku);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory(sku);
CREATE INDEX IF NOT EXISTS idx_carts_expires ON carts(expires_at);
CREATE INDEX IF NOT EXISTS idx_carts_status ON carts(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_discounts_code ON discounts(code);
CREATE INDEX IF NOT EXISTS idx_discounts_status ON discounts(status);
CREATE INDEX IF NOT EXISTS idx_discount_usage_order ON discount_usage(order_id);
CREATE INDEX IF NOT EXISTS idx_discount_usage_customer ON discount_usage(discount_id, customer_email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_usage_order_discount ON discount_usage(order_id, discount_id);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_status ON webhooks(status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_authorizations_client ON oauth_authorizations(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access ON oauth_tokens(access_token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_customer ON oauth_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_email_created ON orders(customer_email, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(number);
CREATE INDEX IF NOT EXISTS idx_variants_status ON variants(status);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_order_id ON refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_logs_sku_created ON inventory_logs(sku, created_at);
CREATE INDEX IF NOT EXISTS idx_customers_last_order ON customers(last_order_at);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at);
CREATE INDEX IF NOT EXISTS idx_events_stripe_event_id ON events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_events_type_processed ON events(type, processed_at);
CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_status ON ucp_checkout_sessions(status);
CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_stripe ON ucp_checkout_sessions(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_expires ON ucp_checkout_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_currencies_code ON currencies(code);
CREATE INDEX IF NOT EXISTS idx_currencies_status ON currencies(status);
CREATE INDEX IF NOT EXISTS idx_countries_code ON countries(code);
CREATE INDEX IF NOT EXISTS idx_countries_status ON countries(status);
CREATE INDEX IF NOT EXISTS idx_warehouses_status ON warehouses(status);
CREATE INDEX IF NOT EXISTS idx_warehouses_priority ON warehouses(priority);
CREATE INDEX IF NOT EXISTS idx_shipping_classes_code ON shipping_classes(code);
CREATE INDEX IF NOT EXISTS idx_shipping_classes_status ON shipping_classes(status);
CREATE INDEX IF NOT EXISTS idx_shipping_rates_status ON shipping_rates(status);
CREATE INDEX IF NOT EXISTS idx_regions_status ON regions(status);
CREATE INDEX IF NOT EXISTS idx_regions_default ON regions(is_default);
CREATE INDEX IF NOT EXISTS idx_regions_currency ON regions(currency_id);
CREATE INDEX IF NOT EXISTS idx_region_countries_region ON region_countries(region_id);
CREATE INDEX IF NOT EXISTS idx_region_countries_country ON region_countries(country_id);
CREATE INDEX IF NOT EXISTS idx_region_warehouses_region ON region_warehouses(region_id);
CREATE INDEX IF NOT EXISTS idx_region_warehouses_warehouse ON region_warehouses(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_region_shipping_rates_region ON region_shipping_rates(region_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_inventory_sku ON warehouse_inventory(sku);
CREATE INDEX IF NOT EXISTS idx_warehouse_inventory_warehouse ON warehouse_inventory(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_inventory_logs_sku ON warehouse_inventory_logs(sku, created_at);
CREATE INDEX IF NOT EXISTS idx_variant_prices_variant ON variant_prices(variant_id);
CREATE INDEX IF NOT EXISTS idx_variant_prices_currency ON variant_prices(currency_id);
CREATE INDEX IF NOT EXISTS idx_carts_region ON carts(region_id);
CREATE INDEX IF NOT EXISTS idx_orders_region ON orders(region_id);
CREATE INDEX IF NOT EXISTS idx_orders_warehouse ON orders(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_tax_rates_country ON tax_rates(country_code);
CREATE INDEX IF NOT EXISTS idx_tax_rates_tax_code ON tax_rates(tax_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_viewtoken ON orders(viewtoken);
CREATE INDEX IF NOT EXISTS idx_carts_shipping_country ON carts(shipping_country);
CREATE INDEX IF NOT EXISTS idx_customers_auth_provider_id ON customers(auth_provider_id);

CREATE TABLE IF NOT EXISTS product_reviews (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id  TEXT REFERENCES customers(id) ON DELETE SET NULL,
  author_name  TEXT NOT NULL,
  author_email TEXT NOT NULL,
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title        TEXT,
  body         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  is_verified_purchase INTEGER NOT NULL DEFAULT 0,
  order_id     TEXT REFERENCES orders(id) ON DELETE SET NULL,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_reviews_product
  ON product_reviews (product_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_reviews_customer
  ON product_reviews (customer_id);

-- ============================================================
-- SAVED CARTS (migration 026)
-- ============================================================

CREATE TABLE IF NOT EXISTS saved_carts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  auth0_user_id TEXT NOT NULL,
  cart_id       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(auth0_user_id, cart_id),
  FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_saved_carts_user ON saved_carts(auth0_user_id);

-- ============================================================
-- CATEGORIES (migrations 027 + 031)
-- ============================================================

CREATE TABLE IF NOT EXISTS categories (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  parent_id     TEXT REFERENCES categories(id) ON DELETE SET NULL,
  image_url     TEXT,
  thumbnail_url TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_categories (
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_product_categories_category ON product_categories (category_id, position);
CREATE INDEX IF NOT EXISTS idx_categories_handle_active ON categories (handle) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories (parent_id) WHERE status = 'active';

-- ============================================================
-- STORE THEMES (migration 030)
-- ============================================================

CREATE TABLE IF NOT EXISTS store_themes (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 0,
  config_json TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- ORDER EMAIL SETTINGS (migration 032)
-- ============================================================

CREATE TABLE IF NOT EXISTS order_email_settings (
  id        TEXT PRIMARY KEY,
  event     TEXT NOT NULL UNIQUE
            CHECK (event IN ('global','pending','paid','payment_failed','processing','shipped','delivered','refunded','canceled')),
  enabled   INTEGER NOT NULL DEFAULT 0,
  subject   TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;


export class MerchantDO extends DurableObject<MerchantEnv> {
  private sql: SqlStorage;
  private sessions: Map<WebSocket, { topics: Set<string> }> = new Map();
  private initialized = false;
  private keysInitialized = false;
  private shippingInitialized = false;

  constructor(ctx: DurableObjectState, env: MerchantEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  private async hashKey(key: string): Promise<string> {
    const data = new TextEncoder().encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private uuid(): string {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    ensureLegacyRoutingColumns(this.sql);
    ensureSchemaObjects(this.sql,SCHEMA);
    ensureSchemaObjects(this.sql,PANCAKE_SCHEMA);
    ensureSchemaObjects(this.sql,CUSTOMER_SESSION_SCHEMA);
    ensureSchemaObjects(this.sql,STOREFRONT_CONTENT_SCHEMA);
    ensureStoreThemeDefaults(this.sql);

    // Migration helper: ensure all pending migrations run.
    // This system uses a migrations table to track which migrations have been applied.
    try {
      const migrationsResult = this.sql.exec('SELECT name FROM migrations');
      const appliedMigrations = new Set(
        (migrationsResult.toArray() as Array<{ name: string }>).map((r) => r.name)
      );

      const migrations: Array<{ name: string; sql: string }> = [
        {
          name: 'viewtoken',
          sql: 'ALTER TABLE orders ADD COLUMN viewtoken TEXT',
        },
        {
          name: 'viewtoken_issued_at',
          sql: 'ALTER TABLE orders ADD COLUMN viewtoken_issued_at TEXT',
        },
        {
          name: 'confirmationemailsentat',
          sql: 'ALTER TABLE orders ADD COLUMN confirmationemailsentat TEXT',
        },
        {
          name: 'confirmationemaillasterror',
          sql: 'ALTER TABLE orders ADD COLUMN confirmationemaillasterror TEXT',
        },
        {
          name: 'confirmationemailupdatedat',
          sql: 'ALTER TABLE orders ADD COLUMN confirmationemailupdatedat TEXT',
        },
        // GAP-01: Shipping address fields on carts (migration 017)
        {
          name: 'cart_shipping_name',
          sql: 'ALTER TABLE carts ADD COLUMN shipping_name TEXT',
        },
        {
          name: 'cart_shipping_line1',
          sql: 'ALTER TABLE carts ADD COLUMN shipping_line1 TEXT',
        },
        {
          name: 'cart_shipping_line2',
          sql: 'ALTER TABLE carts ADD COLUMN shipping_line2 TEXT',
        },
        {
          name: 'cart_shipping_city',
          sql: 'ALTER TABLE carts ADD COLUMN shipping_city TEXT',
        },
        {
          name: 'cart_shipping_state',
          sql: 'ALTER TABLE carts ADD COLUMN shipping_state TEXT',
        },
        {
          name: 'cart_shipping_postal_code',
          sql: 'ALTER TABLE carts ADD COLUMN shipping_postal_code TEXT',
        },
        {
          name: 'cart_shipping_country',
          sql: 'ALTER TABLE carts ADD COLUMN shipping_country TEXT',
        },
        {
          name: 'cart_billing_same_as_shipping',
          sql: 'ALTER TABLE carts ADD COLUMN billing_same_as_shipping INTEGER DEFAULT 1',
        },
        // ─── Migration 018: Shipping classes ───────────────────────────────────
        // Allow products to belong to shipping classes that require specific rates.
        {
          name: 'shipping_classes_table',
          sql: `
            CREATE TABLE IF NOT EXISTS shipping_classes (
              id          TEXT PRIMARY KEY,
              code        TEXT NOT NULL UNIQUE,
              display_name TEXT NOT NULL,
              description TEXT,
              resolution  TEXT NOT NULL DEFAULT 'exclusive'
                          CHECK (resolution IN ('exclusive', 'additive')),
              status      TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'inactive')),
              created_at  TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `,
        },
        {
          name: 'shipping_classes_idx_code',
          sql: 'CREATE INDEX IF NOT EXISTS idx_shipping_classes_code ON shipping_classes (code)',
        },
        {
          name: 'shipping_classes_idx_status',
          sql: 'CREATE INDEX IF NOT EXISTS idx_shipping_classes_status ON shipping_classes (status)',
        },
        {
          name: 'products_add_shipping_class_id',
          sql: 'ALTER TABLE products ADD COLUMN shipping_class_id TEXT',
        },
        {
          name: 'variants_add_shipping_class_id',
          sql: 'ALTER TABLE variants ADD COLUMN shipping_class_id TEXT',
        },
        {
          name: 'shipping_rates_add_shipping_class_id',
          sql: 'ALTER TABLE shipping_rates ADD COLUMN shipping_class_id TEXT',
        },
        {
          name: 'idx_products_shipping_class',
          sql: 'CREATE INDEX IF NOT EXISTS idx_products_shipping_class ON products (shipping_class_id)',
        },
        {
          name: 'idx_variants_shipping_class',
          sql: 'CREATE INDEX IF NOT EXISTS idx_variants_shipping_class ON variants (shipping_class_id)',
        },
        {
          name: 'idx_shipping_rates_shipping_class',
          sql: 'CREATE INDEX IF NOT EXISTS idx_shipping_rates_shipping_class ON shipping_rates (shipping_class_id)',
        },
        // ── Migration 019 ── Variant enrichment ───────────────────────────────
        // Add requiresshipping (blocking for shipping calculation) and optional
        // enrichment fields: barcode, compare_at_price_cents, tax_code.
        // Also adds vendor, tags, handle to products.
        {
          name: 'variants_add_requires_shipping',
          sql: 'ALTER TABLE variants ADD COLUMN requires_shipping INTEGER NOT NULL DEFAULT 1',
        },
        {
          name: 'variants_add_barcode',
          sql: 'ALTER TABLE variants ADD COLUMN barcode TEXT',
        },
        {
          name: 'variants_add_compare_at_price_cents',
          sql: 'ALTER TABLE variants ADD COLUMN compare_at_price_cents INTEGER',
        },
        {
          name: 'variants_add_tax_code',
          sql: 'ALTER TABLE variants ADD COLUMN tax_code TEXT',
        },
        {
          name: 'products_add_vendor',
          sql: 'ALTER TABLE products ADD COLUMN vendor TEXT',
        },
        {
          name: 'products_add_tags',
          sql: 'ALTER TABLE products ADD COLUMN tags TEXT',
        },
        {
          name: 'products_add_handle',
          // SQLite does not allow adding a UNIQUE column via ALTER TABLE.
          // Create a regular TEXT column and enforce uniqueness with an index.
          sql: 'ALTER TABLE products ADD COLUMN handle TEXT',
        },
        {
          name: 'idx_variants_requires_shipping',
          sql: 'CREATE INDEX IF NOT EXISTS idx_variants_requires_shipping ON variants(requires_shipping)',
        },
        {
          name: 'idx_variants_barcode',
          sql: 'CREATE INDEX IF NOT EXISTS idx_variants_barcode ON variants(barcode)',
        },
        {
          name: 'idx_products_vendor',
          sql: 'CREATE INDEX IF NOT EXISTS idx_products_vendor ON products(vendor)',
        },
        {
          name: 'idx_products_handle',
          // Enforce uniqueness for non-null handles.
          sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_products_handle ON products(handle) WHERE handle IS NOT NULL',
        },
        {
          name: '020_add_tax_rates',
          sql: `CREATE TABLE IF NOT EXISTS tax_rates (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            country_code TEXT,
            tax_code TEXT,
            rate_percentage REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
            created_at TEXT NOT NULL DEFAULT datetime('now'),
            updated_at TEXT NOT NULL DEFAULT datetime('now')
          );`,
        },
        {
          name: 'idx_tax_rates_country',
          sql: `CREATE INDEX IF NOT EXISTS idx_tax_rates_country ON tax_rates(country_code);`,
        },
        {
          name: 'idx_tax_rates_tax_code',
          sql: `CREATE INDEX IF NOT EXISTS idx_tax_rates_tax_code ON tax_rates(tax_code);`,
        },
        {
          name: 'carts_add_locale',
          sql: "ALTER TABLE carts ADD COLUMN locale TEXT NOT NULL DEFAULT 'en-US'",
        },
        {
          name: '021_regions_add_tax_inclusive',
          sql: "ALTER TABLE regions ADD COLUMN tax_inclusive INTEGER NOT NULL DEFAULT 0",
        },
        {
          name: '022_add_taxes_json',
          sql: "ALTER TABLE carts ADD COLUMN taxes_json TEXT; ALTER TABLE orders ADD COLUMN taxes_json TEXT;",
        },
        {
          name: '023_shipping_rates_add_tax_code',
          sql: "ALTER TABLE shipping_rates ADD COLUMN tax_code TEXT",
        },
        {
          name: '024_shipping_rates_add_tax_inclusive',
          sql: "ALTER TABLE shipping_rates ADD COLUMN tax_inclusive INTEGER NOT NULL DEFAULT 0",
        },
        // ── Migration 025 ── Customer Auth0 sub lookup indexes ────────────────
        // Fast lookup for resolving customers from Auth0 JWT 'sub' claim.
        {
          name: '025_idx_customers_auth_provider_id',
          sql: 'CREATE INDEX IF NOT EXISTS idx_customers_auth_provider_id ON customers(auth_provider_id)',
        },
        {
          name: '025_idx_customers_email',
          sql: 'CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email)',
        },
        // ── Migration 026 ── Saved carts table for Auth0 users ──────────────────
        // Links Auth0 users to their saved carts via auth0_user_id (JWT 'sub' claim).
        {
          name: '026_saved_carts_table',
          sql: `
            CREATE TABLE IF NOT EXISTS saved_carts (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              auth0_user_id TEXT NOT NULL,
              cart_id       INTEGER NOT NULL,
              created_at    TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
              UNIQUE(auth0_user_id, cart_id),
              FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE
            )
          `,
        },
        {
          name: '026_idx_saved_carts_user',
          sql: 'CREATE INDEX IF NOT EXISTS idx_saved_carts_user ON saved_carts(auth0_user_id)',
        },
        {
          name: '026_trg_saved_carts_updated_at',
          sql: `
            CREATE TRIGGER IF NOT EXISTS trg_saved_carts_updated_at
            AFTER UPDATE ON saved_carts
            FOR EACH ROW
            BEGIN
              UPDATE saved_carts SET updated_at = datetime('now') WHERE id = NEW.id;
            END
          `,
        },
        // ── Migration 027 ── Product categories (hierarchical) ─────────────────────
        // Allow products to belong to multiple categories via join table.
        // Categories can have optional parent_id for hierarchical navigation.
        {
          name: '027_categories_table',
          sql: `
            CREATE TABLE IF NOT EXISTS categories (
              id          TEXT PRIMARY KEY,
              handle      TEXT NOT NULL UNIQUE,
              name        TEXT NOT NULL,
              description TEXT,
              parent_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
              image_url   TEXT,
              position    INTEGER NOT NULL DEFAULT 0,
              status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
              created_at  TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `,
        },
        {
          name: '027_product_categories_table',
          sql: `
            CREATE TABLE IF NOT EXISTS product_categories (
              product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
              category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
              position    INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (product_id, category_id)
            )
          `,
        },
        {
          name: '027_idx_product_categories_category',
          sql: 'CREATE INDEX IF NOT EXISTS idx_product_categories_category ON product_categories (category_id, position)',
        },
        {
          name: '027_idx_categories_handle_active',
          sql: 'CREATE INDEX IF NOT EXISTS idx_categories_handle_active ON categories (handle) WHERE status = \'active\'',
        },
        {
          name: '027_idx_categories_parent',
          sql: 'CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories (parent_id) WHERE status = \'active\'',
        },
        {
          name: '027_trg_categories_updated_at',
          sql: `
            CREATE TRIGGER IF NOT EXISTS trg_categories_updated_at
            AFTER UPDATE ON categories
            FOR EACH ROW
            BEGIN
              UPDATE categories SET updated_at = datetime('now') WHERE id = NEW.id;
            END
          `,
        },
        // ── Migration 028 ── Product reviews ──────────────────────────────────────
        // Allows authenticated customers to leave moderated star ratings.
        {
          name: '028_product_reviews_table',
          sql: `
            CREATE TABLE IF NOT EXISTS product_reviews (
              id           TEXT PRIMARY KEY,
              product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
              customer_id  TEXT REFERENCES customers(id) ON DELETE SET NULL,
              author_name  TEXT NOT NULL,
              author_email TEXT NOT NULL,
              rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
              title        TEXT,
              body         TEXT,
              status       TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected')),
              is_verified_purchase INTEGER NOT NULL DEFAULT 0,
              order_id     TEXT REFERENCES orders(id) ON DELETE SET NULL,
              helpful_count INTEGER NOT NULL DEFAULT 0,
              created_at   TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `,
        },
        {
          name: '028_idx_product_reviews_product',
          sql: 'CREATE INDEX IF NOT EXISTS idx_product_reviews_product ON product_reviews (product_id, status, created_at DESC)',
        },
        {
          name: '028_idx_product_reviews_customer',
          sql: 'CREATE INDEX IF NOT EXISTS idx_product_reviews_customer ON product_reviews (customer_id)',
        },
        {
          name: '028_trg_product_reviews_updated_at',
          sql: `
            CREATE TRIGGER IF NOT EXISTS trg_product_reviews_updated_at
            AFTER UPDATE ON product_reviews
            FOR EACH ROW
            BEGIN
              UPDATE product_reviews SET updated_at = datetime('now') WHERE id = NEW.id;
            END
          `,
        },
        {
          name: '028_products_add_review_count',
          sql: 'ALTER TABLE products ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0',
        },
        {
          name: '028_products_add_average_rating',
          sql: 'ALTER TABLE products ADD COLUMN average_rating REAL NOT NULL DEFAULT 0.0',
        },
        {
          name: '029_variants_add_thumbnail_url',
          sql: 'ALTER TABLE variants ADD COLUMN thumbnail_url TEXT',
        },
        // ── Migration 030 ── Store themes ─────────────────────────────────
        {
          name: '030_store_themes_table',
          sql: `CREATE TABLE IF NOT EXISTS store_themes (
            id          TEXT    PRIMARY KEY,
            name        TEXT    NOT NULL,
            is_active   INTEGER NOT NULL DEFAULT 0,
            config_json TEXT    NOT NULL,
            created_at  TEXT    NOT NULL DEFAULT current_timestamp,
            updated_at  TEXT    NOT NULL DEFAULT current_timestamp
          )`,
        },
        {
          name: '030_store_themes_trigger',
          sql: `CREATE TRIGGER IF NOT EXISTS trg_store_themes_updated_at
            AFTER UPDATE ON store_themes FOR EACH ROW
            BEGIN
              UPDATE store_themes SET updated_at = current_timestamp WHERE id = OLD.id;
            END`,
        },
        {
          name: '030_store_themes_seed_classic',
          sql: `INSERT OR IGNORE INTO store_themes (id, name, is_active, config_json)
            VALUES (
              'theme_classic', 'Fufuni Classic', 1,
              '{"themeSlug":"light","radius":"md","accentOklch":"oklch(87.41% 0.0128 244.59)"}'
            )`,
        },
        {
          name: '030_store_themes_seed_luxury',
          sql: `INSERT OR IGNORE INTO store_themes (id, name, is_active, config_json)
            VALUES (
              'theme_luxury', 'Luxury Minimal', 0,
              '{"themeSlug":"luxury","radius":"none","accentOklch":"oklch(15% 0 0)"}'
            )`,
        },
        // ── Migration 031 ── Categories: add thumbnail_url ───────────────────────
        // Small WebP thumbnail (≤ 300 px) auto-generated on image upload.
        // Stored as base64 data URI for images < 1 MB, or as an R2 URL otherwise.
        {
          name: '031_categories_add_thumbnail_url',
          sql: 'ALTER TABLE categories ADD COLUMN thumbnail_url TEXT',
        },
        // ── Migration 032 ── Order status email notifications ────────────────────
        {
          name: '032_order_email_settings_table',
          sql: `CREATE TABLE IF NOT EXISTS order_email_settings (
            id        TEXT PRIMARY KEY,
            event     TEXT NOT NULL UNIQUE
                      CHECK (event IN ('global','pending','paid','payment_failed','processing','shipped','delivered','refunded','canceled')),
            enabled   INTEGER NOT NULL DEFAULT 0,
            subject   TEXT NOT NULL DEFAULT '',
            html_body TEXT NOT NULL DEFAULT '',
            text_body TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`,
        },
        {
          name: '032_orders_add_locale',
          sql: "ALTER TABLE orders ADD COLUMN locale TEXT NOT NULL DEFAULT 'en-US'",
        },
        // ── Migration 033 ── Expand order_email_settings CHECK constraint ────────
        {
          name: '033_order_email_settings_add_pending_paid',
          sql: `
            CREATE TABLE IF NOT EXISTS order_email_settings_new (
              id        TEXT PRIMARY KEY,
              event     TEXT NOT NULL UNIQUE
                        CHECK (event IN ('global','pending','paid','payment_failed','processing','shipped','delivered','refunded','canceled')),
              enabled   INTEGER NOT NULL DEFAULT 0,
              subject   TEXT NOT NULL DEFAULT '',
              html_body TEXT NOT NULL DEFAULT '',
              text_body TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO order_email_settings_new SELECT * FROM order_email_settings;
            DROP TABLE order_email_settings;
            ALTER TABLE order_email_settings_new RENAME TO order_email_settings;
          `,
        },
        // ── Migration 034 ── Enrich refunds table ─────────────────────────────
        {
          name: '034_enrich_refunds',
          sql: `
            ALTER TABLE refunds ADD COLUMN currency TEXT NOT NULL DEFAULT 'EUR';
            ALTER TABLE refunds ADD COLUMN reason TEXT CHECK(reason IN ('duplicate', 'fraudulent', 'requested_by_customer'));
            ALTER TABLE refunds ADD COLUMN notes TEXT;
            ALTER TABLE refunds ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
            CREATE INDEX IF NOT EXISTS idx_refunds_order_id_created ON refunds(order_id, created_at DESC);
          `,
        },
        // ── Migration 035 ── Digital products and AI token packages ───────────
        // Adds variant_type discriminator, downloadable asset metadata, and
        // per-customer AI token balance + transaction ledger.
        {
          name: '035_variants_add_variant_type',
          sql: `ALTER TABLE variants ADD COLUMN variant_type TEXT NOT NULL DEFAULT 'physical'
                CHECK (variant_type IN ('physical', 'digital', 'ai_tokens'))`,
        },
        {
          name: '035_variants_add_ai_token_units',
          sql: 'ALTER TABLE variants ADD COLUMN ai_token_units INTEGER',
        },
        {
          name: '035_idx_variants_type',
          sql: 'CREATE INDEX IF NOT EXISTS idx_variants_type ON variants (variant_type)',
        },
        {
          name: '035_digital_assets_table',
          sql: `
            CREATE TABLE IF NOT EXISTS digital_assets (
              id            TEXT PRIMARY KEY,
              sku           TEXT NOT NULL UNIQUE REFERENCES inventory (sku) ON DELETE CASCADE,
              storage_type  TEXT NOT NULL DEFAULT 'url' CHECK (storage_type IN ('url', 'r2')),
              storage_value TEXT NOT NULL,
              filename      TEXT NOT NULL,
              content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
              created_at    TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `,
        },
        {
          name: '035_trg_digital_assets_updated_at',
          sql: `
            CREATE TRIGGER IF NOT EXISTS trg_digital_assets_updated_at
            AFTER UPDATE ON digital_assets
            FOR EACH ROW
            BEGIN
              UPDATE digital_assets SET updated_at = datetime('now') WHERE id = NEW.id;
            END
          `,
        },
        {
          name: '035_ai_token_balances_table',
          sql: `
            CREATE TABLE IF NOT EXISTS ai_token_balances (
              customer_id    TEXT PRIMARY KEY REFERENCES customers (id) ON DELETE CASCADE,
              api_key        TEXT NOT NULL,
              balance_units  INTEGER NOT NULL DEFAULT 0,
              updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `,
        },
        {
          name: '035_idx_ai_token_balances_api_key',
          sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_token_balances_api_key ON ai_token_balances (api_key)',
        },
        {
          name: '035_ai_token_transactions_table',
          sql: `
            CREATE TABLE IF NOT EXISTS ai_token_transactions (
              id           TEXT PRIMARY KEY,
              api_key      TEXT NOT NULL,
              customer_id  TEXT REFERENCES customers (id) ON DELETE SET NULL,
              order_id     TEXT REFERENCES orders (id) ON DELETE SET NULL,
              amount       INTEGER NOT NULL,
              type         TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
              note         TEXT,
              created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `,
        },
        {
          name: '035_idx_ai_token_transactions_api_key',
          sql: 'CREATE INDEX IF NOT EXISTS idx_ai_token_transactions_api_key ON ai_token_transactions (api_key, created_at DESC)',
        },
        {
          name: '035_idx_ai_token_transactions_order',
          sql: 'CREATE INDEX IF NOT EXISTS idx_ai_token_transactions_order ON ai_token_transactions (order_id)',
        },
      ];

      for (const migration of migrations) {
        if (!appliedMigrations.has(migration.name)) {
          try {
            this.sql.exec(migration.sql);
            this.sql.exec('INSERT INTO migrations (name) VALUES (?)', migration.name);
          } catch (e) {
            // If migration fails (e.g., column already exists or SQLite rejects a unique constraint on ALTER TABLE),
            // mark it as applied anyway so we don't continuously re-run failing SQL.
            try {
              this.sql.exec('INSERT INTO migrations (name) VALUES (?)', migration.name);
            } catch {
              // Already recorded
            }
          }
        }
      }

      // Some migration runs may have been marked applied even if the SQL failed.
      // Ensure key schema changes are present regardless.
      try {
        const hasHandle = (this.sql.exec('PRAGMA table_info(products)').toArray() as Array<{ name: string }>).
          some((c) => c.name === 'handle');
        if (!hasHandle) {
          this.sql.exec('ALTER TABLE products ADD COLUMN handle TEXT');
        }
      } catch {
        // Ignore if products table doesn't exist yet.
      }

      // Ensure we have an index for fast lookup and to prevent token collisions.
      ensureSchemaObjects(this.sql,'CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_viewtoken ON orders(viewtoken)');
      
      // Index for filtering carts by destination country (GAP-01)
      ensureSchemaObjects(this.sql,'CREATE INDEX IF NOT EXISTS idx_carts_shipping_country ON carts(shipping_country)');
    } catch {
      // If table doesn't exist yet or sqlite doesn't support the operation, ignore.
    }

    // Run outside the legacy best-effort migration catch: failed upgrades must retry.
    this.ctx.storage.transactionSync(() => {ensureCartItemCurrency(this.sql);ensureOrderCheckoutSchema(this.sql);repairLegacyReservationDeficits(this.sql);});

    this.initialized = true;
  }

  private async initializeDefaultKeys(): Promise<void> {
    if (this.keysInitialized) return;
    // Deployment-wide legacy keys must never be seeded into another store.
    if (!this.ctx.id.equals(this.env.MERCHANT.idFromName('default'))) {
      this.keysInitialized = true;
      return;
    }

    const merchantSk = (this.env as any).MERCHANT_SK;
    const merchantPk = (this.env as any).MERCHANT_PK;

    if (merchantSk) {
      const skHash = await this.hashKey(merchantSk);
      try {
        this.sql.exec(
          `INSERT OR IGNORE INTO api_keys (id, key_hash, key_prefix, role, created_at) 
           VALUES (?, ?, ?, 'admin', datetime('now'))`,
          this.uuid(),
          skHash,
          'sk_' + merchantSk.substring(3, 8)
        );
      } catch (e) {
        // Key already exists, ignore
      }
    }

    if (merchantPk) {
      const pkHash = await this.hashKey(merchantPk);
      try {
        this.sql.exec(
          `INSERT OR IGNORE INTO api_keys (id, key_hash, key_prefix, role, created_at) 
           VALUES (?, ?, ?, 'public', datetime('now'))`,
          this.uuid(),
          pkHash,
          'pk_' + merchantPk.substring(3, 8)
        );
      } catch (e) {
        // Key already exists, ignore
      }
    }

    this.keysInitialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureInitialized();
    await this.initializeDefaultKeys();

    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, storage: 'sqlite' });
    }

    return new Response('Not found', { status: 404 });
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    this.ensureInitialized();
    const cursor = this.sql.exec(sql, ...params);
    return cursor.toArray() as T[];
  }

  run(sql: string, params: unknown[] = []): { changes: number } {
    this.ensureInitialized();
    this.sql.exec(sql, ...params);
    const [result] = this.sql.exec('SELECT changes() as changes').toArray() as [{ changes: number }];
    return { changes: result.changes };
  }

  ucpPaymentBegin(id: string, successUrl: string, cancelUrl: string,expected?:{version:number;total:number}) {
    this.ensureInitialized(); ensureSchemaObjects(this.sql, UCP_PAYMENT_SCHEMA);
    return this.ctx.storage.transactionSync(() => beginUcpPayment(this.sql, id, successUrl, cancelUrl,Date.now(),expected));
  }
  ucpPaymentExpire(id:string,stripeId:string){this.ensureInitialized();ensureSchemaObjects(this.sql,UCP_PAYMENT_SCHEMA);return this.ctx.storage.transactionSync(()=>expireUcpPayment(this.sql,id,stripeId));}
  ucpPaymentAttach(id: string, stripeId: string, url: string) {
    this.ensureInitialized(); ensureSchemaObjects(this.sql, UCP_PAYMENT_SCHEMA);
    return this.ctx.storage.transactionSync(() => attachUcpPayment(this.sql, id, stripeId, url));
  }
  ucpPaymentSettle(input: SettlementInput) {
    this.ensureInitialized(); ensureSchemaObjects(this.sql, UCP_PAYMENT_SCHEMA);
    ensureSchemaObjects(this.sql, POD_SCHEMA);
    return this.ctx.storage.transactionSync(() => settleUcpPayment(this.sql, input));
  }
  checkoutRpc(command:import('./lib/checkout-core').CheckoutRpcCommand):import('./lib/checkout-core').CheckoutRpcResult{
    try{let value:ReturnType<typeof checkoutRead>;switch(command.action){
     case 'get':value=this.checkoutGet(command.id);break;
     case 'change-payment':this.checkoutInit();value=this.ctx.storage.transactionSync(()=>changeCheckoutPayment(this.sql,command.id,command.version,command.expiredStripeId));break;
     case 'create':value=this.checkoutCreate(command.input,command.source,command.key);break;
     case 'update':value=this.checkoutUpdate(command.id,command.patch,command.source,command.key,command.version,command.browser);break;
     case 'cancel':value=this.checkoutCancel(command.id,command.source,command.key);break;
     case 'redeem':value=this.checkoutRedeem(command.id);break;
     default:throw new ShippingError('unsupported_checkout_operation',400,'Unsupported checkout operation');
    }return {ok:true,value};}catch(error){if(error instanceof ShippingError)return {ok:false,error:{code:error.code,status:error.status,message:error.message}};if(error instanceof Error&&error.name==='ZodError')return {ok:false,error:{code:'invalid_input',status:400,message:'Invalid checkout input'}};throw error;}
  }
  checkoutFulfillmentPrepare(id:string,method:'stripe'|'techcombank_qr'|'cod',config:FulfillmentConfig){this.checkoutInit();this.ensureCommerceStorage();return this.ctx.storage.transactionSync(()=>prepareCheckoutFulfillment(this.sql,id,method,config));}
  checkoutCodBegin(id:string,expected:{version:number;total:number}){this.checkoutInit();this.ensureCommerceStorage();return this.ctx.storage.transactionSync(()=>beginCodPayment(this.sql,id,expected));}
  checkoutBankBegin(id:string,expected:{version:number;total:number},bank:{account_number:string;account_name:string}){this.checkoutInit();return this.ctx.storage.transactionSync(()=>beginBankPayment(this.sql,id,expected,bank));}
  checkoutBankVerify(id:string,input:Parameters<typeof verifyBankPayment>[2],actor:string){this.checkoutInit();return this.ctx.storage.transactionSync(()=>verifyBankPayment(this.sql,id,input,actor));}
  checkoutBankClose(id:string,actor:string,evidence:string){this.checkoutInit();return this.ctx.storage.transactionSync(()=>closeBankPayment(this.sql,id,actor,evidence));}
  storefrontImport(input:Parameters<typeof importStorefrontCatalog>[1],actor:string){this.ensureInitialized();ensureSchemaObjects(this.sql,STOREFRONT_CONTENT_SCHEMA);ensureSchemaObjects(this.sql,STOREFRONT_MIGRATION_SCHEMA);return this.ctx.storage.transactionSync(()=>importStorefrontCatalog(this.sql,input,actor));}
  storefrontAccess(input:Parameters<typeof provisionStorefrontAccess>[1]){this.ensureInitialized();return this.ctx.storage.transactionSync(()=>provisionStorefrontAccess(this.sql,input));}
  checkoutInit(){this.podInit();ensureSchemaObjects(this.sql,UCP_PAYMENT_SCHEMA);ensureSchemaObjects(this.sql,CHECKOUT_SCHEMA);ensureSchemaObjects(this.sql,FULFILLMENT_SCHEMA);}
  checkoutReconcileAllow(id:string){this.checkoutInit();return this.ctx.storage.transactionSync(()=>{const now=Date.now(),[row]=this.sql.exec('SELECT next_at FROM checkout_reconcile_rates WHERE id=?',id).toArray();if(row&&Number(row.next_at)>now)return false;this.sql.exec('INSERT INTO checkout_reconcile_rates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at',id,now+10000);return true;});}
  checkoutReadiness(cursor:string,skus?:string[],carrierCountry?:string){this.checkoutInit();return checkoutReadiness(this.sql,cursor,skus,carrierCountry);}
  checkoutCarrierSave(id:string,quoteId:string,version:number,options:Parameters<typeof saveCheckoutCarrier>[4],context:string,execution?:unknown){this.checkoutInit();return this.ctx.storage.transactionSync(()=>saveCheckoutCarrier(this.sql,id,quoteId,version,options,context,Date.now(),execution));}
  checkoutGet(id:string){this.checkoutInit();return checkoutRead(this.sql,id);}
  checkoutCreate(raw:RetailCheckoutInput,source:string,key:string){this.checkoutInit();const input=checkoutInput.parse(raw);return this.ctx.storage.transactionSync(()=>checkoutCommand(this.sql,source+':create',key,input,()=>checkoutSave(this.sql,input,source)));}
  checkoutUpdate(id:string,patch:Partial<RetailCheckoutInput>,source:string,key:string,version?:number,browser=false){this.checkoutInit();return this.ctx.storage.transactionSync(()=>checkoutCommand(this.sql,source+':update:'+id,key,{patch,version:version??null,browser},()=>{
    const current=checkoutRead(this.sql,id);if(current.source!==source||(!browser&&current.claimed)||(browser&&source!=='web'&&!current.claimed))throw new ShippingError('checkout_locked',409,'Continue this checkout in the merchant browser');
    const [draft]=this.sql.exec('SELECT input_json FROM checkout_drafts WHERE id=?',id).toArray();return checkoutSave(this.sql,checkoutInput.parse({...JSON.parse(String(draft.input_json)),...patch}),source,id,version);
  }));}
  checkoutCancel(id:string,source:string,key:string){this.checkoutInit();return this.ctx.storage.transactionSync(()=>checkoutCommand(this.sql,source+':cancel:'+id,key,{},()=>checkoutCancel(this.sql,id,source)));}
  checkoutRedeem(id:string){this.checkoutInit();return this.ctx.storage.transactionSync(()=>{const current=checkoutRead(this.sql,id);if(current.claimed||['expired','canceled','completed','complete_in_progress'].includes(current.status))throw new ShippingError('handoff_closed',409,'Handoff is no longer available');this.sql.exec('INSERT INTO checkout_handoffs VALUES(?,?,?)',id,id,Date.now());this.sql.exec('UPDATE checkout_drafts SET claimed=1 WHERE id=?',id);return checkoutRead(this.sql,id);});}
  podInit() { this.ensureInitialized(); ensureSchemaObjects(this.sql,POD_SCHEMA); }
  podV2Init(){this.podInit();ensureSchemaObjects(this.sql,POD_V2_SCHEMA);}
  podV2(command:PodV2Command){this.podV2Init();return this.ctx.storage.transactionSync(()=>podV2Command(this.sql,command));}
  feedSnapshot(){this.podInit();ensureSchemaObjects(this.sql,FEED_SCHEMA);return this.ctx.storage.transactionSync(()=>feedSnapshot(this.sql));}
  shoppingAiAllow(client:string){this.ensureInitialized();ensureSchemaObjects(this.sql,SHOPPING_SCHEMA);return this.ctx.storage.transactionSync(()=>allowShoppingAi(this.sql,client));}
  shoppingConsume(id:string,selection:ShoppingSelection,expiresAt:number){this.podInit();ensureSchemaObjects(this.sql,FEED_SCHEMA);ensureSchemaObjects(this.sql,SHOPPING_SCHEMA);return this.ctx.storage.transactionSync(()=>consumeShopping(this.sql,feedSnapshot(this.sql).offers,id,selection,expiresAt));}
  feedPut(sku:string,config:FeedOffer,storeUrl:string){this.podInit();ensureSchemaObjects(this.sql,FEED_SCHEMA);return this.ctx.storage.transactionSync(()=>putFeedOffer(this.sql,sku,config,storeUrl));}
  marketingInit(){this.checkoutInit();ensureSchemaObjects(this.sql,MARKETING_SCHEMA);ensureSchemaObjects(this.sql,EXPERIMENT_SCHEMA);}
  marketingRecoverCheckout(id:string,subscriberId:string){this.marketingInit();return this.ctx.storage.transactionSync(()=>recoverCheckoutMarketing(this.sql,id,subscriberId));}
  marketingRfm(cursor:string){this.marketingInit();return this.ctx.storage.transactionSync(()=>marketingRfm(this.sql,cursor));}
  marketingExperiment(raw:Parameters<typeof createExperiment>[1]){this.marketingInit();return this.ctx.storage.transactionSync(()=>createExperiment(this.sql,raw));}
  marketingExperimentReport(){this.marketingInit();return this.ctx.storage.transactionSync(()=>experimentReport(this.sql));}
  marketingSubscribe(input:SubscriptionInput,policy:string){this.marketingInit();return this.ctx.storage.transactionSync(()=>subscribeMarketing(this.sql,input,policy));}
  marketingConfirm(id:string,nonce:string,policy:string){this.marketingInit();return this.ctx.storage.transactionSync(()=>confirmMarketing(this.sql,id,nonce,policy));}
  marketingUnsubscribe(id:string){this.marketingInit();return this.ctx.storage.transactionSync(()=>unsubscribeMarketing(this.sql,id));}
  marketingPlan(){this.marketingInit();return this.ctx.storage.transactionSync(()=>planMarketing(this.sql));}
  marketingClaim(token:string){this.marketingInit();return this.ctx.storage.transactionSync(()=>claimMarketing(this.sql,token));}
  marketingEligible(id:string,token:string){this.marketingInit();return marketingEligible(this.sql,id,token);}
  marketingFinish(id:string,token:string,outcome:Parameters<typeof finishMarketing>[3],providerId?:string){this.marketingInit();return this.ctx.storage.transactionSync(()=>finishMarketing(this.sql,id,token,outcome,providerId));}
  marketingEvent(input:Parameters<typeof recordMarketingEvent>[1]){this.marketingInit();return this.ctx.storage.transactionSync(()=>recordMarketingEvent(this.sql,input));}
  podDue() { this.podInit();return this.sql.exec("SELECT id FROM pod_fulfillments WHERE (state IN ('queued','accepted','in_production','partially_shipped','shipped','submission_unknown') OR (state='needs_review' AND external_id IS NOT NULL)) AND lease_until<? AND updated_at<? ORDER BY updated_at LIMIT 10",Date.now(),Date.now()-60_000).toArray().map(r=>({id:String(r.id)})); }
  podApprove(id:string,evidence:string) {this.podInit();return this.ctx.storage.transactionSync(()=>approvePodArtwork(this.sql,id,evidence));}
  podReview(id:string,evidence:string,approve:boolean) {this.podInit();return this.ctx.storage.transactionSync(()=>reviewPodArtwork(this.sql,id,evidence,approve));}
  podSaveDraft(sku:string,config:unknown,actor:string) {this.podInit();return this.ctx.storage.transactionSync(()=>savePodMappingDraft(this.sql,sku,config,actor));}
  podPlan(input:PodQuoteInput) {this.podInit();return podQuotePlan(this.sql,input);}
  podStoreQuote(plan:ReturnType<typeof podQuotePlan>,shipping:number) {
    this.podInit();return this.ctx.storage.transactionSync(()=>storePodQuote(this.sql,plan,shipping));
  }
  podCheckout(cartId:string,quoteId:string,expected:number) {
    this.podInit();return this.ctx.storage.transactionSync(()=>checkoutPodQuote(this.sql,cartId,quoteId,expected));
  }
  podClaim(id:string,token:string) {this.podInit();return this.ctx.storage.transactionSync(()=>claimPodFulfillment(this.sql,id,token));}
  podFinish(id:string,token:string,result:Parameters<typeof finishPodFulfillment>[3]) {
    this.podInit();return this.ctx.storage.transactionSync(()=>finishPodFulfillment(this.sql,id,token,result));
  }
  ctxlayerState(input:StateCommand) {
    this.ensureInitialized(); ensureSchemaObjects(this.sql,INTEGRATION_SCHEMA);
    return this.ctx.storage.transactionSync(()=>integrationState(this.sql,input));
  }
  ctxlayerRegistration(config:string,clientId?:string) {
    this.ensureInitialized();
    this.sql.exec('CREATE TABLE IF NOT EXISTS ctxlayer_clients(config TEXT PRIMARY KEY, client_id TEXT NOT NULL)');
    if(clientId)this.sql.exec('INSERT OR IGNORE INTO ctxlayer_clients VALUES(?,?)',config,clientId);
    return String(this.sql.exec('SELECT client_id FROM ctxlayer_clients WHERE config=?',config).toArray()[0]?.client_id||'');
  }
  beginPancakeMcpRun(run:RunContext) {
    this.ctxlayerState({op:'get'});
    return this.ctx.storage.transactionSync(()=>beginMcpRun(this.sql,run));
  }
  applyPancakeMcpRun(snapshot:PancakeSnapshot,run:RunContext) {
    this.ctxlayerState({op:'get'});
    return this.ctx.storage.transactionSync(()=>commitMcpRun(this.sql,snapshot,run));
  }
  failPancakeMcpRun(run:RunContext,code:string) {
    this.ctxlayerState({op:'get'});
    this.ctx.storage.transactionSync(()=>failMcpRun(this.sql,run,code));
  }
  pancakeMcpRun(id:string) {
    this.ctxlayerState({op:'get'});
    return this.sql.exec('SELECT id,shop_id,source,state,started_at,finished_at,error_code,report_json FROM pancake_sync_runs WHERE id=?',id).toArray()[0]||null;
  }
  warnPancakeMcpRun(id:string) {
    this.ctxlayerState({op:'get'});
    this.sql.exec("UPDATE pancake_sync_runs SET state='succeeded_with_warning',error_code='cache_invalidation' WHERE id=? AND state='succeeded'",id);
  }

  acquirePancakeSync(shopId: string, token: string): boolean {
    this.ensureInitialized();
    return this.ctx.storage.transactionSync(() => acquirePosLease(this.sql, shopId, token));
  }

  shippingCart(cartId:string) {this.ensureInitialized();return shippingResult(()=>loadShippingCart(this.sql,cartId));}
  private ensureCommerceStorage() {
    this.ensureShippingStorage();
    ensureSchemaObjects(this.sql,COMMERCE_SCHEMA);
    ensureSchemaObjects(this.sql,SERVICE_SCHEMA);
    ensureSchemaObjects(this.sql,shippingFlow.SHIPPING_WORKFLOW_SCHEMA);
  }

  shippingBootstrap(id:string,enabled:boolean) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>{
    const leg=shippingFlow.ensureOutboundLeg(this.sql,id);
    if(leg.owner==='direct'&&enabled&&!leg.tracking_code&&!this.sql.exec("SELECT id FROM shipping_commands WHERE leg_id=? AND kind='create'",leg.id).toArray().length){
      shippingFlow.enqueueShippingCommand(this.sql,{leg_id:leg.id,kind:'create',idempotency_key:crypto.randomUUID()},'shipping-automation');
    }
    return leg;
  }));}
  shippingOverview(id:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.shippingOverview(this.sql,id)));}
  shippingEnqueue(input:shippingFlow.ShippingCommandInput,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.enqueueShippingCommand(this.sql,input,actor)));}
  shippingClaim(id:string,token:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.claimShippingCommand(this.sql,id,token)));}
  shippingMark(id:string,token:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.markShippingAttempt(this.sql,id,token)));}
  shippingObserve(id:string,observation:shippingFlow.CarrierObservation,token?:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.observeShipping(this.sql,id,observation,Date.now(),token)));}
  shippingFinish(id:string,token:string,state:Parameters<typeof shippingFlow.finishShippingCommand>[3],result:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.finishShippingCommand(this.sql,id,token,state,result)));}
  shippingDue() {this.ensureCommerceStorage();return shippingFlow.shippingDue(this.sql);}
  shippingReceive(input:Parameters<typeof shippingFlow.receiveShippingEvent>[1]) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.receiveShippingEvent(this.sql,input)));}
  shippingEventsDue() {this.ensureCommerceStorage();return shippingFlow.shippingEventsDue(this.sql);}
  shippingLinkEvent(id:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.linkShippingEvent(this.sql,id)));}
  shippingFinishEvent(id:string,success:boolean) {this.ensureCommerceStorage();shippingFlow.finishShippingEvent(this.sql,id,success);}
  shippingPollClaim(id:string,token:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.claimShippingPoll(this.sql,id,token)));}
  shippingPollFinish(id:string,token:string,error:string|null) {this.ensureCommerceStorage();shippingFlow.finishShippingPoll(this.sql,id,token,error);}
  shippingPollDue() {this.ensureCommerceStorage();return this.sql.exec("SELECT * FROM shipping_legs WHERE status NOT IN ('delivered','returned','cancel','exception','lost','damage','scrap') AND next_poll_at<=? AND lease_until<=? AND (tracking_code IS NOT NULL OR EXISTS(SELECT 1 FROM shipping_commands c WHERE c.leg_id=shipping_legs.id AND c.attempted=1)) ORDER BY next_poll_at,observed_at LIMIT 10",Date.now(),Date.now()).toArray() as unknown as shippingFlow.Leg[];}
  shippingQueue() {this.ensureCommerceStorage();return shippingFlow.shippingQueue(this.sql);}
  shippingRetry(id:string,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.retryShippingCommand(this.sql,id,actor)));}
  shippingCircuitStatus() {this.ensureCommerceStorage();return shippingFlow.shippingCircuitStatus(this.sql);}
  shippingQuoteResults(outcomes:Parameters<typeof shippingFlow.reportShippingQuotes>[1]) {this.ensureCommerceStorage();this.ctx.storage.transactionSync(()=>shippingFlow.reportShippingQuotes(this.sql,outcomes));}
  shippingPrepareLeg(input:Parameters<typeof shippingFlow.prepareExternalLeg>[1],account:Parameters<typeof shippingFlow.prepareExternalLeg>[2],actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.prepareExternalLeg(this.sql,input,account,actor)));}
  shippingPosObservation(id:string,pos:Parameters<typeof shippingFlow.observePosShipping>[2]) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.observePosShipping(this.sql,id,pos)));}
  shippingQueueApproved(id:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.queueApprovedShipping(this.sql,id)));}
  shippingServiceDue() {this.ensureCommerceStorage();return {requests:this.sql.exec("SELECT DISTINCT order_id FROM commerce_requests WHERE status='approved' AND kind IN ('cancel','address') LIMIT 20").toArray().map(r=>String(r.order_id)),completions:this.sql.exec("SELECT c.id FROM shipping_commands c JOIN commerce_requests r ON r.id=c.request_id WHERE c.state='verified' AND c.result='carrier_and_pos_verified' AND r.status='approved' LIMIT 20").toArray().map(r=>String(r.id))};}
  shippingServiceComplete(commandId:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>shippingFlow.completeShippingService(this.sql,commandId)));}

  commerceReplay(input:CheckoutInput) {this.ensureCommerceStorage();return shippingResult(()=>replayCheckout(this.sql,input));}
  confirmCommerceCheckout(input:CheckoutInput,config:CheckoutConfig) {
    this.ensureCommerceStorage();
    return shippingResult(()=>this.ctx.storage.transactionSync(()=>confirmCheckout(this.sql,input,config)));
  }
  commerceReceipt(id:string) {this.ensureCommerceStorage();return shippingResult(()=>receipt(this.sql,id));}
  commerceNotificationClaim() {this.ensureCommerceStorage();return this.ctx.storage.transactionSync(()=>serviceNotificationClaim(this.sql));}
  commerceNotificationFinish(id:string,sent:boolean) {this.ensureCommerceStorage();serviceNotificationFinish(this.sql,id,sent);}
  commerceRecovery(number:string,email:string) {this.ensureCommerceStorage();return serviceRecovery(this.sql,number,email);}
  commerceEvidenceStore(id:string,key:string,mime:string,hash:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>storeServiceEvidence(this.sql,id,key,mime,hash)));}
  commerceEvidenceRead(id:string,evidenceId:string) {this.ensureCommerceStorage();return shippingResult(()=>readServiceEvidence(this.sql,id,evidenceId));}
  commerceAddressAdjustment(id:string,input:z.infer<typeof adjustmentInput>,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>recordAddressAdjustment(this.sql,id,input,actor)));}
  commerceServiceReconcile(id:string,version:number,evidence:string,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>reconcileServicePayment(this.sql,id,version,evidence,actor)));}
  commerceExpireHolds() {this.ensureCommerceStorage();const ids=this.sql.exec("SELECT c.order_id FROM commerce_orders c WHERE c.reservation_state='held' AND c.payment_status IN ('pending','unpaid') AND c.expires_at<? AND c.pancake_order_id IS NULL AND NOT EXISTS(SELECT 1 FROM commerce_outbox b WHERE b.order_id=c.order_id AND b.create_attempted=1) AND NOT EXISTS(SELECT 1 FROM commerce_requests r WHERE r.order_id=c.order_id AND r.status IN ('pending','approved')) ORDER BY c.expires_at LIMIT 20",Date.now()).toArray();return ids.map(r=>shippingResult(()=>this.ctx.storage.transactionSync(()=>expireServiceHold(this.sql,String(r.order_id)))));}
  commerceServiceDetail(id:string) {this.ensureCommerceStorage();return shippingResult(()=>serviceDetail(this.sql,id));}
  commerceServiceQueue() {this.ensureCommerceStorage();return serviceQueue(this.sql);}
  commerceServiceSnapshot(id:string) {this.ensureCommerceStorage();return shippingResult(()=>serviceSnapshot(this.sql,id));}
  commerceServiceRequest(id:string,input:z.infer<typeof requestInput>,hash:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>{assertActionSession(this.sql,id,hash);return createServiceRequest(this.sql,id,input,'verified-customer');}));}
  commerceServiceDecision(id:string,input:z.infer<typeof decisionInput>,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>decideServiceRequest(this.sql,id,input,actor)));}
  commerceRefundCreate(id:string,input:z.infer<typeof refundInput>,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>createRefund(this.sql,id,input,actor)));}
  commerceRefundResult(id:string,input:z.infer<typeof refundResultInput>,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>recordRefundResult(this.sql,id,input,actor)));}
  commerceActionStart(id:string,session:string,hash:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>startActionSession(this.sql,id,session,hash)));}
  commerceActionVerify(id:string,session:string,hash:string,tokenHash:string) {this.ensureCommerceStorage();return this.ctx.storage.transactionSync(()=>verifyActionSession(this.sql,id,session,hash,tokenHash));}
  commerceActionAssert(id:string,hash:string,kind?:'quote'|'evidence') {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>serviceActionAccess(this.sql,id,hash,kind)));}
  commerceAddressQuote(id:string,version:number,recipient:CheckoutInput['recipient'],offer:import('./lib/smart-shipping').ShippingOffer,hash:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>{assertActionSession(this.sql,id,hash);return storeAddressQuote(this.sql,id,version,recipient,offer);}));}
  commerceCancel(id:string,evidence:string,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>cancelPendingOrder(this.sql,id,evidence,actor)));}
  commerceResolveBank(id:string,input:z.infer<typeof bankResolutionInput>,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>{assertLegacyResolution(this.sql,id);return resolveBankException(this.sql,id,input,actor);}));}
  commerceOverviewInit() {this.ensureCommerceStorage();}
  async commerceStorageBookmark() {this.ensureInitialized();return {bookmark:await this.ctx.storage.getCurrentBookmark(),created_at:new Date().toISOString()};}
  commercePending() {this.ensureCommerceStorage();return this.sql.exec("SELECT b.order_id FROM commerce_outbox b JOIN commerce_orders c ON c.order_id=b.order_id LEFT JOIN commerce_shipments s ON s.order_id=c.order_id WHERE (b.state NOT IN ('synced','canceled') AND json_extract(c.snapshot_json,'$.automation_version')=2 AND b.lease_until<?) OR (b.state='synced' AND json_extract(c.snapshot_json,'$.automation_version')=2 AND (s.order_id IS NULL OR (s.state NOT IN ('delivered','returned','canceled') AND s.lease_until<? AND s.next_attempt_at<?))) ORDER BY COALESCE(s.next_attempt_at,0),b.created_at LIMIT 10",Date.now(),Date.now(),Date.now()).toArray().map(r=>({order_id:String(r.order_id)}));}
  commerceEvidence(id:string,kind:'bank_transfer'|'cod_collected'|'cod_reconciled',input:EvidenceInput,actor:string) {
    this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>recordEvidence(this.sql,id,kind,input,actor)));
  }
  commerceFulfillment(id:string,input:z.infer<typeof fulfillmentInput>,actor:string) {
    this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>{if(['ready_to_ship','shipped'].includes(input.state))assertNoOpenChanges(this.sql,id);return updateFulfillment(this.sql,id,input,actor);}));
  }
  commerceShipmentClaim(id:string,token:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>claimShipment(this.sql,id,token)));}
  commerceShipmentAuthorize(id:string,account:string,evidence:string,actor:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>{assertNoOpenChanges(this.sql,id);return authorizeShipment(this.sql,id,account,evidence,actor);}));}
  commerceShipmentMark(id:string,token:string,partner:number,account:number) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>{assertNoOpenChanges(this.sql,id);return markShipmentAttempt(this.sql,id,token,partner,account);}));}
  commerceShipmentFinish(id:string,token:string,result:ShipmentResult) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>finishShipment(this.sql,id,token,result)));}
  commerceClaim(id:string,token:string) {this.ensureCommerceStorage();return shippingResult(()=>this.ctx.storage.transactionSync(()=>{assertNoOpenChanges(this.sql,id);return claimOutbox(this.sql,id,token);}));}
  commerceMarkCreate(id:string,token:string) {return shippingResult(()=>this.ctx.storage.transactionSync(()=>markCreateAttempt(this.sql,id,token)));}
  commerceFinish(id:string,token:string,posId:string|null,error:string|null) {return shippingResult(()=>this.ctx.storage.transactionSync(()=>finishOutbox(this.sql,id,token,posId,error)));}
  private ensureShippingStorage() {
    this.ensureInitialized();
    if(this.shippingInitialized)return;
    ensureSchemaObjects(this.sql,SHIPPING_SCHEMA);
    this.shippingInitialized=true;
  }
  private hasShippingSelectionStorage() {
    this.ensureInitialized();
    return this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='cart_shipping_quotes'").toArray().length>0;
  }
  beginShippingQuote(cartId:string) {this.ensureShippingStorage();return this.ctx.storage.transactionSync(()=>shippingResult(()=>beginShippingQuote(this.sql,cartId)));}
  storeShippingQuote(quote:StoredShippingQuote) {this.ensureShippingStorage();return this.ctx.storage.transactionSync(()=>shippingResult(()=>storeShippingQuote(this.sql,quote)));}
  selectShippingQuote(cartId:string,quoteId:string,optionId:string,policyKey:string) {this.ensureShippingStorage();return this.ctx.storage.transactionSync(()=>shippingResult(()=>selectShippingQuote(this.sql,cartId,quoteId,optionId,policyKey)));}
  shippingSelection(cartId:string,policyKey?:string) {if(!this.hasShippingSelectionStorage())return shippingResult(()=>null);return this.ctx.storage.transactionSync(()=>shippingResult(()=>readShippingSelection(this.sql,cartId,policyKey)));}
  clearShippingSelection(cartId:string) {if(!this.hasShippingSelectionStorage())return shippingResult(()=>undefined);return this.ctx.storage.transactionSync(()=>shippingResult(()=>clearShippingSelection(this.sql,cartId)));}

  applyPancakeStock(snapshot: PancakeSnapshot) {this.ensureInitialized();return this.ctx.storage.transactionSync(()=>applyPosStock(this.sql,snapshot));}

  applyPancakeSync(snapshot: PancakeSnapshot) {
    this.ensureInitialized();
    return this.ctx.storage.transactionSync(() => applyPosSnapshot(this.sql, snapshot));
  }

  failPancakeSync(shopId: string, token: string, errorCode: string): void {
    this.ensureInitialized();
    finishPosError(this.sql, shopId, token, errorCode);
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const topics = url.searchParams.get('topics')?.split(',') || ['*'];

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.sessions.set(server, { topics: new Set(topics) });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(message as string);
      const session = this.sessions.get(ws);
      if (!session) return;

      if (data.action === 'subscribe' && data.topic) {
        session.topics.add(data.topic);
      } else if (data.action === 'unsubscribe' && data.topic) {
        session.topics.delete(data.topic);
      }
    } catch {}
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.sessions.delete(ws);
  }

  broadcast(event: WSEvent): void {
    const message = JSON.stringify(event);
    const eventTopic = event.type.split('.')[0];

    for (const [ws, session] of this.sessions) {
      if (session.topics.has('*') || session.topics.has(eventTopic) || session.topics.has(event.type)) {
        try {
          ws.send(message);
        } catch {
          this.sessions.delete(ws);
        }
      }
    }
  }

  async cleanupExpiredCarts(): Promise<number> {
    this.ensureInitialized();

    const now = new Date().toISOString();

    this.sql.exec('DELETE FROM customer_sessions WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM customer_auth_attempts WHERE window_start < ?', Date.now() - 3600_000);
    return this.ctx.storage.transactionSync(() => expireOpenCarts(this.sql,now));
  }
}
