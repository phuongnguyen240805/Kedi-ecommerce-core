import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ensureCartItemCurrency} from '../src/lib/cart-schema';
test('persisted pre-currency cart items upgrade idempotently using each cart currency',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE migrations(name TEXT PRIMARY KEY);CREATE TABLE carts(id TEXT PRIMARY KEY,currency TEXT NOT NULL);CREATE TABLE cart_items(id TEXT PRIMARY KEY,cart_id TEXT,title TEXT,qty INTEGER,unit_price_cents INTEGER);INSERT INTO carts VALUES('vn','VND'),('us','USD');INSERT INTO cart_items VALUES('a','vn','Shirt',1,453000),('b','us','Shirt',2,2500);");
 const sql={exec(query:string,...params:any[]){const rows=db.prepare(query).all(...params) as Record<string,unknown>[];return {toArray:()=>rows}}};
 ensureCartItemCurrency(sql);ensureCartItemCurrency(sql);
 assert.deepEqual(db.prepare('SELECT currency FROM cart_items ORDER BY id').all().map(r=>r.currency),['VND','USD']);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM migrations').get()?.n,1);
 db.prepare('INSERT INTO cart_items(id,cart_id,title,qty,unit_price_cents,currency) VALUES(?,?,?,?,?,?)').run('c','vn','Shirt',1,453000,'VND');
 assert.equal(db.prepare('SELECT SUM(qty*unit_price_cents) n FROM cart_items').get()?.n,911000);db.close();
});
