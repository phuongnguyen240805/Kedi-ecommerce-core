import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import {StagedPrintifyClient,stagedPublicState,type StagedOrder} from '../src/lib/pod-v2-printify';
import {validatePodPrintBytes} from '../src/lib/pod-v2-assets';
import {verifyPrintifyWebhook,podV2Readiness} from '../src/routes/pod-v2';
import type {Env} from '../src/types';

test('P03-T01 P03-T03 PNG decoder validates pixels, safe zones and bounded decompression',async()=>{
 const p=new PNG({width:100,height:100});p.data[(50*100+50)*4+3]=255;const bytes=PNG.sync.write(p);
 assert.deepEqual(await validatePodPrintBytes(bytes,100,100,5),{width:100,height:100});
 await assert.rejects(validatePodPrintBytes(bytes,101,100));
 p.data[3]=255;await assert.rejects(validatePodPrintBytes(PNG.sync.write(p),100,100,5),{code:'pod_safe_zone_violation'});
 await assert.rejects(validatePodPrintBytes(PNG.sync.write(new PNG({width:100,height:100})),100,100),{code:'pod_png_empty_or_truncated'});
 const corrupt=Buffer.from(bytes);corrupt[40]^=1;await assert.rejects(validatePodPrintBytes(corrupt,100,100));
});
test('P05-T01 account-level upload and GET image use dedicated paths; redirects never forward secrets',async()=>{
 const paths:string[]=[];const im={id:'image',file_name:'art.png',width:100,height:100,size:1000,mime_type:'image/png'};
 const client=new StagedPrintifyClient('fixture','111',async(url,init)=>{paths.push(new URL(String(url)).pathname);assert.equal(init?.redirect,'manual');return Response.json(im);});
 await client.upload('art.png','https://merchant.test/art');await client.image('image');assert.deepEqual(paths,['/v1/uploads/images.json','/v1/uploads/image.json']);
 const redirect=new StagedPrintifyClient('fixture','111',async()=>new Response(null,{status:302,headers:{Location:'https://evil.test'}}));await assert.rejects(redirect.image('image'),{code:'provider_http_302'});
});
test('P06-T07 send-to-production accepts an empty 202 body without false failure',async()=>{
 let calls=0;const client=new StagedPrintifyClient('fixture','111',async(url,init)=>{calls++;assert.equal(String(url),'https://api.printify.com/v1/shops/111/orders/order/send_to_production.json');assert.equal(init?.method,'POST');return new Response(null,{status:202});});
 assert.deepEqual(await client.send('order'),{id:'order'});assert.equal(calls,1);
});
test('P01-T01 P06-T03 recovery follows pagination metadata beyond the first short page',async()=>{
 const seen:string[]=[];const target={id:'order',status:'pending',metadata:{shop_order_id:'wanted'},line_items:[{product_id:'p',variant_id:1,quantity:1,metadata:{external_id:'line'}}]};
 const client=new StagedPrintifyClient('fixture','111',async url=>{const u=new URL(String(url));seen.push(u.search);return Response.json({current_page:Number(u.searchParams.get('page')),last_page:3,data:u.searchParams.get('page')==='3'?[target]:[]});});
 assert.equal((await client.findOrder('wanted'))?.id,'order');assert.equal(seen.length,3);assert.ok(seen.every(q=>q.includes('limit=50')));
});
test('P06-T02 duplicate response alone never proves order ownership',()=>{
 const client=new StagedPrintifyClient('fixture','111');const order={id:'order',status:'pending',metadata:{shop_order_id:'reference'},line_items:[{product_id:'other',variant_id:1,quantity:1,metadata:{external_id:'line'}}]};
 assert.throws(()=>client.verifyOrder(order,'reference',[{product_id:'expected',variant_id:1,quantity:1,external_id:'line'}]),{code:'pod_order_lines_mismatch'});
});
test('P07-T01 P07-T02 HMAC uses raw bytes, supports rotation and rejects changed payloads',async()=>{
 const secret='fixture-webhook-secret-at-least-32-characters',bytes=new TextEncoder().encode('{"id":"event"}');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const digest=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 assert.equal(await verifyPrintifyWebhook(bytes,'sha256='+digest,['wrong-fixture-secret-at-least-32-characters',secret]),true);
 assert.equal(await verifyPrintifyWebhook(new TextEncoder().encode('{}'),'sha256='+digest,[secret]),false);
 assert.equal(await verifyPrintifyWebhook(bytes,digest,[secret]),false);
});
test('P07-T05 partial shipment is not delivered; readiness fails closed without R2',()=>{
 const o:StagedOrder={id:'o',status:'in-production',metadata:{shop_order_id:'r'},line_items:[{product_id:'p',variant_id:1,quantity:2}],shipments:[{carrier:'C',number:'N',delivered_at:'today'}]};
 assert.equal(stagedPublicState(o),'partially_shipped');assert.equal(stagedPublicState({...o,status:'fulfilled'}),'delivered');
 assert.deepEqual(podV2Readiness({} as Env),{enabled:false,storage_ready:false,provider_configured:false,asset_signing_ready:false,production_enabled:false,bank_ready:false});
});
