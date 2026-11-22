import type {ShippingSql} from './shipping-store';
/** Open carts never reserve inventory; provider-owned holds expire through provider evidence. */
export function expireOpenCarts(sql:ShippingSql,now:string){
 const rows=sql.exec("SELECT id FROM carts WHERE status='open' AND expires_at<? ORDER BY expires_at LIMIT 100",now).toArray();
 if(!rows.length)return 0;const ids=rows.map(row=>String(row.id)),slots=ids.map(()=>'?').join(',');
 sql.exec("UPDATE carts SET status='expired' WHERE id IN ("+slots+")",...ids);
 sql.exec('DELETE FROM cart_items WHERE cart_id IN ('+slots+')',...ids);return ids.length;
}
/** Repair only provable reservation deficits caused by legacy open-cart cleanup. Never add physical stock. */
export function repairLegacyReservationDeficits(sql:ShippingSql){
 const name='037_open_cart_reservation_repair';
 if(sql.exec('SELECT name FROM migrations WHERE name=?',name).toArray().length)return;
 if(!sql.exec("SELECT name FROM sqlite_master WHERE name='ucp_stock_holds'").toArray().length)return;
 sql.exec('CREATE TABLE IF NOT EXISTS inventory_reservation_repairs(id TEXT PRIMARY KEY,sku TEXT NOT NULL,before_reserved INTEGER NOT NULL,after_reserved INTEGER NOT NULL,ucp_held INTEGER NOT NULL,warehouse_reserved INTEGER NOT NULL,cause TEXT NOT NULL,created_at TEXT NOT NULL)');
 const rows=sql.exec("SELECT i.sku,i.on_hand,i.reserved,COALESCE((SELECT SUM(h.qty) FROM ucp_stock_holds h WHERE h.sku=i.sku AND h.state='held'),0) held,COALESCE((SELECT SUM(MAX(w.reserved,0)) FROM warehouse_inventory w WHERE w.sku=i.sku),0) wh_reserved FROM inventory i WHERE i.reserved<0 OR EXISTS(SELECT 1 FROM ucp_stock_holds h WHERE h.sku=i.sku AND h.state='held')").toArray();
 for(const row of rows){const held=Number(row.held),wh=Number(row.wh_reserved),floor=held+wh,before=Number(row.reserved);if(before>=floor||Number(row.on_hand)<floor)continue;
  sql.exec('UPDATE inventory SET reserved=?,updated_at=? WHERE sku=? AND reserved=? AND on_hand>=?',floor,new Date().toISOString(),row.sku,before,floor);
  sql.exec('INSERT INTO inventory_reservation_repairs VALUES(?,?,?,?,?,?,?,?)',crypto.randomUUID(),row.sku,before,floor,held,wh,name,new Date().toISOString());
 }
 sql.exec('INSERT INTO migrations(name) VALUES(?)',name);
}
