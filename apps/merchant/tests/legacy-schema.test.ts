import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureLegacyRoutingColumns} from '../src/lib/sql-schema';
test('pre-region database gets nullable index columns without losing existing carts/orders/customers',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE carts(id TEXT PRIMARY KEY);CREATE TABLE orders(id TEXT PRIMARY KEY,total_cents INTEGER);CREATE TABLE customers(id TEXT PRIMARY KEY);INSERT INTO carts VALUES('cart');INSERT INTO orders VALUES('order',2500);INSERT INTO customers VALUES('buyer');");
 const sql={exec:(query:string)=>{const rows=db.prepare(query).all() as Record<string,unknown>[];return {toArray:()=>rows};}};
 ensureLegacyRoutingColumns(sql);ensureLegacyRoutingColumns(sql);
 db.exec('CREATE INDEX idx_carts_region ON carts(region_id);CREATE INDEX idx_orders_region ON orders(region_id);CREATE INDEX idx_orders_warehouse ON orders(warehouse_id);CREATE INDEX idx_orders_viewtoken ON orders(viewtoken);CREATE INDEX idx_carts_shipping_country ON carts(shipping_country);CREATE INDEX idx_customers_auth ON customers(auth_provider_id);');
 assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id=?').get('order')!.total_cents,2500);assert.equal(db.prepare('SELECT region_id FROM carts').get()!.region_id,null);assert.equal(db.prepare('SELECT id FROM customers').get()!.id,'buyer');
});
test('fresh databases need no legacy ALTER, existing routing values survive repeated initialization',()=>{
 const db=new DatabaseSync(':memory:');const sql={exec:(query:string)=>{const rows=db.prepare(query).all() as Record<string,unknown>[];return {toArray:()=>rows};}};ensureLegacyRoutingColumns(sql);
 db.exec("CREATE TABLE carts(id TEXT,region_id TEXT,shipping_country TEXT);INSERT INTO carts VALUES('cart','vn','VN')");ensureLegacyRoutingColumns(sql);assert.equal(db.prepare('SELECT region_id FROM carts').get()!.region_id,'vn');
});
