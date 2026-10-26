import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { normalizePos, readPos, posGet, getPosConfig, variationSchema, type PosVariation } from '../src/lib/pancake-source';
import { acquirePosLease, applyPosSnapshot, PANCAKE_SCHEMA, type SyncSql } from '../src/lib/pancake-store';

const warehouse={id:'warehouse-pos',name:'Hali Fruit',address:'Đà Nẵng',allow_create_order:true};
const row:PosVariation=variationSchema.parse({id:'v1',product_id:'p1',display_id:'SKU-TAO',retail_price:129000,weight:500,
  product:{name:'Táo Đà Lạt',display_id:'P-TAO'},images:['https://example.com/tao.png'],
  variations_warehouses:[{warehouse_id:warehouse.id,remain_quantity:10}]});
function memoryStore(){
 const db=new DatabaseSync(':memory:');
 const source=readFileSync(new URL('../src/do.ts',import.meta.url),'utf8');
 const schema=source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];if(!schema)throw Error('Missing merchant schema');
 db.exec(schema);db.exec("ALTER TABLE variants ADD COLUMN variant_type TEXT NOT NULL DEFAULT 'physical'");
 db.exec(PANCAKE_SCHEMA);
 db.exec("INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('vnd','VND','VND',0)");
 const sql:SyncSql={exec:(query,...params)=>{const rows=db.prepare(query).all(...params) as Record<string,unknown>[];return {toArray:()=>rows};}};
 const apply=(snapshot:Awaited<ReturnType<typeof normalizePos>>)=>{
  db.exec('BEGIN');try{const result=applyPosSnapshot(sql,snapshot);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
 };
 return {db,sql,apply};
}
afterEach(()=>mock.restoreAll());
describe('Pancake catalog persistence',()=>{
 it('repeated sync retains IDs, updates VND price and stock, and preserves reservations',async()=>{
  const {db,sql,apply}=memoryStore();assert.equal(acquirePosLease(sql,'1','first'),true);
  const first=await normalizePos('1',warehouse,[row],'first');assert.equal(apply(first).created_products,1);
  assert.equal(db.prepare('SELECT weight_g FROM variants').get()?.weight_g,500);
  const sku=first.variants[0].sku;db.prepare('UPDATE inventory SET reserved=3 WHERE sku=?').run(sku);
  db.prepare('UPDATE warehouse_inventory SET reserved=3 WHERE sku=?').run(sku);
  assert.equal(acquirePosLease(sql,'1','second'),true);
  const second=await normalizePos('1',warehouse,[{...row,weight:800,retail_price:149000,variations_warehouses:[{warehouse_id:warehouse.id,remain_quantity:8}]}],'second');
  const result=apply(second);assert.equal(result.created_products,0);assert.equal(result.created_variants,0);
  assert.equal(second.variants[0].id,first.variants[0].id);
  assert.equal(db.prepare('SELECT price_cents FROM variant_prices').get()?.price_cents,149000);
  assert.equal(db.prepare('SELECT weight_g FROM variants').get()?.weight_g,800);
  assert.deepEqual({...db.prepare('SELECT on_hand,reserved FROM warehouse_inventory').get()},{on_hand:8,reserved:3});
  assert.deepEqual({...db.prepare('SELECT on_hand,reserved FROM inventory').get()},{on_hand:8,reserved:3});db.close();
 });
 it('zero-price and fractional-stock variants stay draft; missing warehouse stock is never taken from other warehouses',async()=>{
  const zero=await normalizePos('1',warehouse,[{...row,retail_price:0}],'a');
  assert.equal(zero.products[0].status,'draft');assert.equal(zero.variants[0].status,'draft');
  const fractional=await normalizePos('1',warehouse,[{...row,variations_warehouses:[{warehouse_id:warehouse.id,remain_quantity:1.5}]}],'b');
  assert.equal(fractional.variants[0].status,'draft');
  const missing=await normalizePos('1',warehouse,[{...row,variations_warehouses:[{warehouse_id:'other',remain_quantity:500}]}],'c');
  assert.equal(missing.variants[0].quantity,0);
 });
 it('an unchanged complete snapshot writes only sync metadata and a removed SKU can reappear',async()=>{
  const {db,sql,apply}=memoryStore();acquirePosLease(sql,'1','a');apply(await normalizePos('1',warehouse,[row],'a'));
  acquirePosLease(sql,'1','b');const before=Number(db.prepare('SELECT total_changes() AS n').get()?.n);
  apply(await normalizePos('1',warehouse,[row],'b'));const after=Number(db.prepare('SELECT total_changes() AS n').get()?.n);
  assert.equal(after-before,1,'Only completion metadata should change for an identical snapshot');
  acquirePosLease(sql,'1','c');apply(await normalizePos('1',warehouse,[],'c'));
  acquirePosLease(sql,'1','d');apply(await normalizePos('1',warehouse,[row],'d'));
  assert.equal(db.prepare('SELECT status FROM variants').get()?.status,'active');
  assert.equal(db.prepare('SELECT on_hand FROM inventory').get()?.on_hand,10);db.close();
 });
 it('hides removed products and zeros stock on a complete snapshot, but not on a single-product trial',async()=>{
  const {db,sql,apply}=memoryStore();acquirePosLease(sql,'1','a');apply(await normalizePos('1',warehouse,[row],'a'));
  acquirePosLease(sql,'1','b');apply(await normalizePos('1',warehouse,[],'b',false));
  assert.equal(db.prepare('SELECT status FROM products').get()?.status,'active');
  acquirePosLease(sql,'1','c');apply(await normalizePos('1',warehouse,[],'c'));
  assert.equal(db.prepare('SELECT status FROM products').get()?.status,'draft');
  assert.equal(db.prepare('SELECT status FROM variants').get()?.status,'draft');
  assert.equal(db.prepare('SELECT on_hand FROM inventory').get()?.on_hand,0);db.close();
 });
 it('rejects overlapping or stale sync and rolls back the entire snapshot on a SKU collision',async()=>{
  const {db,sql,apply}=memoryStore();assert.equal(acquirePosLease(sql,'1','owner'),true);
  assert.equal(acquirePosLease(sql,'1','other'),false);
  assert.throws(()=>applyPosSnapshot(sql,{token:'other',shopId:'1'} as never),/lease/);
  const snapshot=await normalizePos('1',warehouse,[row,{...row,id:'v2',product_id:'p2',display_id:'SKU-OTHER'}],'owner');
  snapshot.variants[1].sku=snapshot.variants[0].sku;
  assert.throws(()=>apply(snapshot));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get()?.n,0);db.close();
 });
 it('duplicate POS SKU labels get distinct stable fallback SKUs and VND prices are not divided by 100',async()=>{
  const snapshot=await normalizePos('1',warehouse,[row,{...row,id:'v2',retail_price_by_currency:[{currency:'VND',retailPriceByCurrency:'59000'}]}],'a');
  assert.equal(new Set(snapshot.variants.map(v=>v.sku)).size,2);assert.equal(snapshot.variants[1].price,59000);
 });
});
const config={PANCAKE_SHOP_ID:'1',PANCAKE_API_KEY:'secret-test',PANCAKE_WAREHOUSE_ID:warehouse.id};
describe('Pancake API boundary',()=>{
 it('reads all pages before returning a validated snapshot',async()=>{
  let calls=0;mock.method(globalThis,'fetch',async()=>{calls++;
   return Response.json(calls===1?{success:true,data:[warehouse]}:calls===2?
    {success:true,data:[row],total_pages:2,total_entries:2,page_number:1}:
    {success:true,data:[{...row,id:'v2'}],total_pages:2,total_entries:2,page_number:2});});
  assert.equal((await readPos(config)).variations.length,2);assert.equal(calls,3);
 });
 it('does not return a partial catalog on a failed page',async()=>{
  let calls=0;mock.method(globalThis,'fetch',async()=>{calls++;return calls===1?Response.json({success:true,data:[warehouse]}):calls===2?
   Response.json({success:true,data:[row],total_pages:2,total_entries:2,page_number:1}):new Response('api_key=secret-test',{status:503});});
  await assert.rejects(readPos(config),/HTTP 503/);
 });
 it('rejects duplicate records caused by inconsistent pagination',async()=>{
  let calls=0;mock.method(globalThis,'fetch',async()=>{calls++;return Response.json(calls===1?{success:true,data:[warehouse]}:
    {success:true,data:[row],total_pages:2,total_entries:2,page_number:calls-1});});
  await assert.rejects(readPos(config),/duplicate/);
 });
 it('never forwards secret-bearing fetch errors or follows redirects',async()=>{
  const fn=mock.method(globalThis,'fetch',async()=>{throw Error('https://pos.pages.fm/?api_key=secret-test');});
  await assert.rejects(posGet(getPosConfig(config),'warehouses'),/Pancake request failed/);
  assert.equal((fn.mock.calls[0].arguments[1] as RequestInit).redirect,'manual');
 });
});

describe('digital POS catalogs',()=>{
 it('imports digital variants without shipping and preserves a manual type on later sync',async()=>{
  const {db,sql,apply}=memoryStore();
  try {
   acquirePosLease(sql,'2','first');const first=await normalizePos('2',warehouse,[row],'first',true,'digital');apply(first);
   assert.deepEqual({...db.prepare('SELECT variant_type,requires_shipping FROM variants').get()},{variant_type:'digital',requires_shipping:0});
   db.prepare("UPDATE variants SET variant_type='ai_tokens',requires_shipping=0").run();
   acquirePosLease(sql,'2','second');apply(await normalizePos('2',warehouse,[{...row,retail_price:99900}],'second',true,'digital'));
   assert.equal(db.prepare('SELECT variant_type FROM variants').get()?.variant_type,'ai_tokens');
  } finally {db.close();}
 });
 it('keeps identical SKU labels in two store databases independent',async()=>{
  const a=memoryStore();const b=memoryStore();
  try {
   acquirePosLease(a.sql,'1','a');a.apply(await normalizePos('1',warehouse,[row],'a'));
   acquirePosLease(b.sql,'2','b');b.apply(await normalizePos('2',warehouse,[{...row,retail_price:88800}],'b',true,'digital'));
   assert.equal(a.db.prepare('SELECT price_cents FROM variants').get()?.price_cents,129000);
   assert.equal(b.db.prepare('SELECT price_cents FROM variants').get()?.price_cents,88800);
   assert.notEqual(a.db.prepare('SELECT id FROM variants').get()?.id,b.db.prepare('SELECT id FROM variants').get()?.id);
  } finally {a.db.close();b.db.close();}
 });
});
