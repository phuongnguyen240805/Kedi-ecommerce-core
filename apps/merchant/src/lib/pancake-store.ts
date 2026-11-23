import type { PancakeSnapshot } from './pancake-source';
export interface SyncSql {exec:(query:string,...params:(string|number|null)[])=>{toArray:()=>Record<string,unknown>[]};}
export const PANCAKE_SCHEMA=`
CREATE TABLE IF NOT EXISTS pancake_links (
 shop_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
 source_sku TEXT, seen_token TEXT NOT NULL, PRIMARY KEY(shop_id,kind,source_id), UNIQUE(kind,target_id)
);
CREATE TABLE IF NOT EXISTS pancake_sync_state (
 shop_id TEXT PRIMARY KEY, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 last_attempt_at TEXT, last_completed_at TEXT, last_error TEXT, warehouse_id TEXT, report_json TEXT
);`;
export function acquirePosLease(sql:SyncSql,shopId:string,token:string,time=Date.now()){
 sql.exec('INSERT OR IGNORE INTO pancake_sync_state (shop_id) VALUES (?)',shopId);
 const state=sql.exec('SELECT lease_until FROM pancake_sync_state WHERE shop_id=?',shopId).toArray()[0];
 if(Number(state.lease_until)>time)return false;
 sql.exec('UPDATE pancake_sync_state SET lease_token=?,lease_until=?,last_attempt_at=?,last_error=NULL WHERE shop_id=?',token,time+300_000,new Date(time).toISOString(),shopId);
 return true;
}
export function finishPosError(sql:SyncSql,shopId:string,token:string,error:string){
 sql.exec('UPDATE pancake_sync_state SET lease_token=NULL,lease_until=0,last_error=? WHERE shop_id=? AND lease_token=?',error,shopId,token);
}
export function applyPosSnapshot(sql:SyncSql,s:PancakeSnapshot){
 const lease=sql.exec('SELECT lease_token,lease_until FROM pancake_sync_state WHERE shop_id=?',s.shopId).toArray()[0];
 if(lease?.lease_token!==s.token||Number(lease.lease_until)<Date.now())throw Error('Pancake sync lease expired');
 const currency=sql.exec("SELECT id,decimal_places FROM currencies WHERE code='VND' AND status='active'").toArray()[0];
 if(!currency||currency.decimal_places!==0)throw Error('Active VND currency with zero decimal places required');
 const time=Date.now();const timestamp=new Date(time).toISOString();let createdProducts=0,createdVariants=0;
 const previous=sql.exec('SELECT warehouse_id FROM pancake_sync_state WHERE shop_id=?',s.shopId).toArray()[0];
 if(previous?.warehouse_id&&previous.warehouse_id!==s.warehouse.id)throw Error('Changing the sync warehouse requires inventory reconciliation');
 const link=(kind:string,source:string,target:string,sku:string|null=null)=>sql.exec(`INSERT INTO pancake_links (shop_id,kind,source_id,target_id,source_sku,seen_token)
 VALUES (?,?,?,?,?,?) ON CONFLICT(shop_id,kind,source_id) DO UPDATE SET source_sku=excluded.source_sku,seen_token=excluded.seen_token
 WHERE pancake_links.source_sku IS NOT excluded.source_sku`,s.shopId,kind,source,target,sku,s.token);
 const w=s.warehouse;
 sql.exec(`INSERT INTO warehouses (id,display_name,address_line1,city,postal_code,country_code,status) VALUES (?,?,?,'','', 'VN','active')
 ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,address_line1=excluded.address_line1,status='active'
 WHERE warehouses.display_name IS NOT excluded.display_name OR warehouses.address_line1 IS NOT excluded.address_line1 OR warehouses.status!='active'`,w.targetId,w.name,w.full_address||w.address||'');
 link('warehouse',w.id,w.targetId);
 // Only associate with VND regions, so checkout can use the selected fulfilment warehouse.
 sql.exec(`INSERT OR IGNORE INTO region_warehouses (region_id,warehouse_id) SELECT id,? FROM regions WHERE currency_id=?`,w.targetId,String(currency.id));
 for(let i=0;i<s.products.length;i++){
  const p=s.products[i];if(!sql.exec('SELECT id FROM products WHERE id=?',p.id).toArray().length)createdProducts++;
  const createdAt=new Date(time-i).toISOString();
  sql.exec(`INSERT INTO products (id,title,description,handle,image_url,status,created_at) VALUES (?,?,?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,image_url=excluded.image_url,status=excluded.status
   WHERE products.title IS NOT excluded.title OR products.description IS NOT excluded.description OR products.image_url IS NOT excluded.image_url OR products.status IS NOT excluded.status`,
   p.id,p.title,p.description,JSON.stringify({'vi-VN':p.handle}),p.image,p.status,createdAt);
  link('product',p.sourceId,p.id);
 }
 for(const v of s.variants){
  const prev=sql.exec('SELECT sku FROM variants WHERE id=?',v.id).toArray()[0];
  if(!prev)createdVariants++;
  if(prev&&prev.sku!==v.sku){
   // Rename managed inventory along with a SKU edit; never reset live reservations.
   sql.exec('UPDATE inventory SET sku=? WHERE sku=?',v.sku,String(prev.sku));
   sql.exec('UPDATE warehouse_inventory SET sku=? WHERE sku=?',v.sku,String(prev.sku));
  }
  sql.exec(`INSERT INTO variants (id,product_id,sku,title,price_cents,currency,image_url,thumbnail_url,barcode,weight_g,requires_shipping,variant_type,status,created_at)
   VALUES (?,?,?,?,?,'VND',?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sku=excluded.sku,title=excluded.title,
   price_cents=excluded.price_cents,currency='VND',image_url=excluded.image_url,thumbnail_url=excluded.thumbnail_url,barcode=excluded.barcode,weight_g=excluded.weight_g,status=excluded.status
   WHERE variants.sku IS NOT excluded.sku OR variants.title IS NOT excluded.title OR variants.price_cents IS NOT excluded.price_cents
    OR variants.currency!='VND' OR variants.image_url IS NOT excluded.image_url OR variants.thumbnail_url IS NOT excluded.thumbnail_url
    OR variants.barcode IS NOT excluded.barcode OR variants.weight_g IS NOT excluded.weight_g OR variants.status IS NOT excluded.status`,
   v.id,v.productId,v.sku,v.title,v.price,v.image,v.image,v.barcode,v.weightG,v.variantType === 'digital' || v.variantType === 'ai_tokens' ? 0 : 1,v.variantType || 'physical',v.status,timestamp);
  sql.exec(`INSERT INTO variant_prices (id,variant_id,currency_id,price_cents,updated_at) VALUES (?,?,?,?,?)
   ON CONFLICT(variant_id,currency_id) DO UPDATE SET price_cents=excluded.price_cents,updated_at=excluded.updated_at
   WHERE variant_prices.price_cents IS NOT excluded.price_cents`,v.id,v.id,String(currency.id),v.price,timestamp);
  // POS remain_quantity already excludes POS holds. Fufuni holds remain separate and are preserved.
  sql.exec(`INSERT INTO warehouse_inventory (id,sku,warehouse_id,on_hand,reserved,updated_at) VALUES (?,?,?,?,0,?)
   ON CONFLICT(sku,warehouse_id) DO UPDATE SET on_hand=excluded.on_hand,updated_at=excluded.updated_at
   WHERE warehouse_inventory.on_hand IS NOT excluded.on_hand`,v.id,v.sku,w.targetId,v.quantity,timestamp);
  sql.exec(`INSERT INTO inventory (id,sku,on_hand,reserved,updated_at) VALUES (?,?,?,0,?)
   ON CONFLICT(sku) DO UPDATE SET on_hand=excluded.on_hand,updated_at=excluded.updated_at
   WHERE inventory.on_hand IS NOT excluded.on_hand`,v.id,v.sku,v.quantity,timestamp);
  link('variation',v.sourceId,v.id,v.sourceSku);
 }
 let retiredVariants=0;
 if(s.full){
  const presentVariants=new Set(s.variants.map(v=>v.id));
  const removed=sql.exec("SELECT target_id FROM pancake_links WHERE shop_id=? AND kind='variation'",s.shopId).toArray().filter(row=>!presentVariants.has(String(row.target_id)));
  for(const row of removed){
   const id=String(row.target_id);sql.exec("UPDATE variants SET status='draft' WHERE id=? AND status!='draft'",id);
   sql.exec('UPDATE warehouse_inventory SET on_hand=0 WHERE sku=(SELECT sku FROM variants WHERE id=?) AND on_hand!=0',id);
   sql.exec('UPDATE inventory SET on_hand=0 WHERE sku=(SELECT sku FROM variants WHERE id=?) AND on_hand!=0',id);retiredVariants++;
  }
  const presentProducts=new Set(s.products.map(p=>p.id));
  for(const row of sql.exec("SELECT target_id FROM pancake_links WHERE shop_id=? AND kind='product'",s.shopId).toArray())
   if(!presentProducts.has(String(row.target_id)))sql.exec("UPDATE products SET status='draft' WHERE id=? AND status!='draft'",String(row.target_id));
 }
 const warningCounts:Record<string,number>={};for(const issue of s.issues)warningCounts[issue.code]=(warningCounts[issue.code]||0)+1;
 const report={shop_id:s.shopId,warehouse_id:w.id,fufuni_warehouse_id:w.targetId,full:s.full,products:s.products.length,variants:s.variants.length,
  created_products:createdProducts,created_variants:createdVariants,updated_products:s.products.length-createdProducts,updated_variants:s.variants.length-createdVariants,
  active_products:s.products.filter(p=>p.status==='active').length,draft_products:s.products.filter(p=>p.status==='draft').length,
  retired_variants:retiredVariants,warnings:warningCounts,issue_samples:s.issues.slice(0,20),completed_at:timestamp};
 sql.exec(`UPDATE pancake_sync_state SET lease_token=NULL,lease_until=0,last_completed_at=?,warehouse_id=?,report_json=?,last_error=NULL WHERE shop_id=?`,timestamp,w.id,JSON.stringify(report),s.shopId);
 return report;
}

/** Stock-only POS refresh: preserve merchant prices, descriptions, type, status and reservations. */
export function applyPosStock(sql:SyncSql,s:PancakeSnapshot){
 const lease=sql.exec('SELECT lease_token,lease_until,warehouse_id FROM pancake_sync_state WHERE shop_id=?',s.shopId).toArray()[0];
 if(lease?.lease_token!==s.token||Number(lease.lease_until)<Date.now())throw Error('Pancake sync lease expired');
 if(lease.warehouse_id&&lease.warehouse_id!==s.warehouse.id)throw Error('Changing the sync warehouse requires inventory reconciliation');
 const timestamp=new Date().toISOString(),w=s.warehouse;
 const targets=s.variants.map(v=>{const row=sql.exec('SELECT id,sku,product_id,variant_type FROM variants WHERE id=?',v.id).toArray()[0];if(!row||row.sku!==v.sku||row.product_id!==v.productId||row.variant_type!=='physical')throw Error('POS stock must match an existing physical merchant variant');if(!Number.isSafeInteger(v.quantity)||v.quantity<0)throw Error('Invalid POS quantity');const foreign=sql.exec("SELECT shop_id FROM pancake_links WHERE kind='variation' AND target_id=? AND shop_id!=?",v.id,s.shopId).toArray();if(foreign.length)throw Error('Variant already managed by another POS shop');return v;});
 if(new Set(targets.map(v=>v.sku)).size!==targets.length)throw Error('Duplicate POS SKU');
 const mappings=[{kind:'warehouse',source:w.id,target:w.targetId},...s.products.filter(p=>targets.some(v=>v.productId===p.id)).map(p=>({kind:'product',source:p.sourceId,target:p.id}))];
 for(const m of mappings){const old=sql.exec('SELECT target_id FROM pancake_links WHERE shop_id=? AND kind=? AND source_id=?',s.shopId,m.kind,m.source).toArray()[0];if(old&&old.target_id!==m.target)throw Error('POS mapping changed; reconcile before stock adoption');if(m.kind==='product'&&sql.exec("SELECT shop_id FROM pancake_links WHERE kind='product' AND target_id=? AND shop_id!=?",m.target,s.shopId).toArray().length)throw Error('Product already belongs to another POS shop');}
 for(const m of mappings)sql.exec('INSERT OR IGNORE INTO pancake_links(shop_id,kind,source_id,target_id,seen_token) VALUES(?,?,?,?,?)',s.shopId,m.kind,m.source,m.target,s.token);

 sql.exec("INSERT INTO warehouses(id,display_name,address_line1,city,postal_code,country_code,status) VALUES(?,?,?,'','','VN','active') ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,address_line1=excluded.address_line1 WHERE warehouses.display_name IS NOT excluded.display_name OR warehouses.address_line1 IS NOT excluded.address_line1",w.targetId,w.name,w.full_address||w.address||'');
 const consumed=new Map<string,number>();if(sql.exec("SELECT name FROM sqlite_master WHERE name='ucp_stock_holds'").toArray().length){for(const row of sql.exec("SELECT sku,SUM(qty) qty FROM ucp_stock_holds WHERE state='consumed' GROUP BY sku").toArray())consumed.set(String(row.sku),Number(row.qty));}
 for(const v of targets){const sourceQuantity=v.status==='active'?v.quantity:0,quantity=Math.max(0,sourceQuantity-(consumed.get(v.sku)||0));
  sql.exec('INSERT INTO warehouse_inventory(id,sku,warehouse_id,on_hand,reserved,updated_at) VALUES(?,?,?,?,0,?) ON CONFLICT(sku,warehouse_id) DO UPDATE SET on_hand=excluded.on_hand,updated_at=excluded.updated_at WHERE warehouse_inventory.on_hand IS NOT excluded.on_hand',v.id,v.sku,w.targetId,quantity,timestamp);
  sql.exec('INSERT INTO inventory(id,sku,on_hand,reserved,updated_at) VALUES(?,?,?,0,?) ON CONFLICT(sku) DO UPDATE SET on_hand=excluded.on_hand,updated_at=excluded.updated_at WHERE inventory.on_hand IS NOT excluded.on_hand',v.id,v.sku,quantity,timestamp);
  sql.exec("INSERT INTO pancake_links(shop_id,kind,source_id,target_id,source_sku,seen_token) VALUES(?,'variation',?,?,?,?) ON CONFLICT(shop_id,kind,source_id) DO UPDATE SET source_sku=excluded.source_sku WHERE pancake_links.source_sku IS NOT excluded.source_sku",s.shopId,v.sourceId,v.id,v.sourceSku,s.token);
 }
 let retired=0;
 if(s.full){const ids=new Set(targets.map(v=>v.id));for(const old of sql.exec("SELECT v.id,v.sku FROM pancake_links l JOIN variants v ON v.id=l.target_id WHERE l.shop_id=? AND l.kind='variation'",s.shopId).toArray()){if(ids.has(String(old.id)))continue;sql.exec('UPDATE inventory SET on_hand=0,updated_at=? WHERE sku=? AND on_hand!=0',timestamp,String(old.sku));sql.exec('UPDATE warehouse_inventory SET on_hand=0,updated_at=? WHERE sku=? AND warehouse_id=? AND on_hand!=0',timestamp,String(old.sku),w.targetId);retired++;}}
 const report={shop_id:s.shopId,warehouse_id:w.id,stock_only:true,local_paid_units_held_back:targets.reduce((sum,v)=>sum+(consumed.get(v.sku)||0),0),full:s.full,products:0,variants:targets.length,retired_variants:retired,warnings:{},completed_at:timestamp};
 sql.exec('UPDATE pancake_sync_state SET lease_token=NULL,lease_until=0,last_completed_at=?,warehouse_id=?,report_json=?,last_error=NULL WHERE shop_id=?',timestamp,w.id,JSON.stringify(report),s.shopId);return report;
}
