/** Upgrade persisted carts without changing their authoritative currency or totals. */
export function ensureCartItemCurrency(sql: {exec(query:string,...params:any[]):{toArray():Record<string,unknown>[]}}) {
 const columns=sql.exec('PRAGMA table_info(cart_items)').toArray();
 if(!columns.some(column=>column.name==='currency'))sql.exec('ALTER TABLE cart_items ADD COLUMN currency TEXT');
 const name='036_cart_items_currency';
 if(sql.exec('SELECT name FROM migrations WHERE name=?',name).toArray().length)return;
 sql.exec('UPDATE cart_items SET currency=(SELECT currency FROM carts WHERE carts.id=cart_items.cart_id) WHERE currency IS NULL');
 sql.exec('INSERT INTO migrations(name) VALUES(?)',name);
}

/** Persisted orders may predate the checkout delivery-selection column. */
export function ensureOrderCheckoutSchema(sql: {exec(query:string,...params:any[]):{toArray():Record<string,unknown>[]}}) {
 if(!sql.exec('PRAGMA table_info(orders)').toArray().some(column=>column.name==='shipping_rate_id'))
  sql.exec('ALTER TABLE orders ADD COLUMN shipping_rate_id TEXT');
}
