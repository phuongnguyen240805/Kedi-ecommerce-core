import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalOffer,openAiRecord,googleItem,feedSnapshot} from '../src/lib/product-feeds';
const config={title:'Shirt & print',description:'<p>A custom shirt.</p>',brand:'Test Brand',seller_name:'Test Merchant',url:'https://shop.test/shirt',image_url:'https://cdn.shop.test/shirt.png',currency:'USD',store_country:'US',target_countries:['US'],mode:'stock',approved:true,availability_verified_until:Date.now()+86400000,identifier_exists:false};
const row={config:JSON.stringify(config),variant_id:'variant-uuid',product_id:'product',variant_status:'active',product_status:'active',price_minor:2500,decimal_places:2,available:2,pod_available:0};
test('one canonical offer powers OpenAI and Google with identical exact price and stable identity',()=>{
 const offer=canonicalOffer(row),openai=openAiRecord(offer),xml=googleItem(offer);assert.equal(openai.price,'25.00 USD');assert.equal(openai.item_id,'variant-uuid');assert.equal(openai.is_eligible_checkout,false);assert.match(xml,/<g:price>25.00 USD<\/g:price>/);assert.match(xml,/Shirt &amp; print/);assert.equal(openai.description,'A custom shirt.');
 const vnd=canonicalOffer({...row,config:JSON.stringify({...config,currency:'VND'}),price_minor:180000,decimal_places:0});assert.equal(vnd.price,'180000 VND');
});
test('missing stock, stale availability or unverified POD never becomes in-stock',()=>{
 assert.equal(canonicalOffer({...row,available:0}).availability,'out_of_stock');
 assert.equal(canonicalOffer({...row,config:JSON.stringify({...config,availability_verified_until:1})}).availability,'out_of_stock');
 assert.equal(canonicalOffer({...row,config:JSON.stringify({...config,mode:'pod'})}).availability,'out_of_stock');
 assert.equal(canonicalOffer({...row,pod_available:1,config:JSON.stringify({...config,mode:'pod'})}).availability,'in_stock');
});
test('invalid identifiers, approval, prices and apparel attributes block publication',()=>{
 assert.throws(()=>canonicalOffer({...row,config:JSON.stringify({...config,approved:false})}));
 assert.throws(()=>canonicalOffer({...row,price_minor:null}));
 assert.throws(()=>canonicalOffer({...row,config:JSON.stringify({...config,gtin:'4006381333932',identifier_exists:true})}));
 assert.throws(()=>canonicalOffer({...row,config:JSON.stringify({...config,google_category:'166'})}));
 assert.throws(()=>canonicalOffer({...row,config:JSON.stringify({...config,url:'https://user:pass@shop.test/shirt'})}));
 assert.equal(canonicalOffer({...row,config:JSON.stringify({...config,gtin:'4006381333931',identifier_exists:true})}).gtin,'4006381333931');
});

test('manufacturer-assigned MPN and supplied return policy are exported without inventing missing identifiers',()=>{const offer=canonicalOffer({...row,config:JSON.stringify({...config,mpn:'REAL-PART-01',identifier_exists:true,return_policy_url:'https://shop.test/returns'})});assert.equal(openAiRecord(offer).mpn,'REAL-PART-01');assert.equal(openAiRecord(offer).return_policy,'https://shop.test/returns');assert.match(googleItem(offer),/<g:mpn>REAL-PART-01<\/g:mpn>/);assert.throws(()=>canonicalOffer({...row,config:JSON.stringify({...config,mpn:'REAL-PART-01',identifier_exists:false})}));assert.ok(!('mpn' in openAiRecord(canonicalOffer(row))));});
test('feed publication rejects duplicate option combinations, mixed parent products or group/item identity collisions',()=>{const grouped=(id:string,size:string,product='product')=>({...row,sku:id,variant_id:id,product_id:product,config:JSON.stringify({...config,group_id:'parent',size,color:'Black'})});for(const records of [[grouped('a','M'),grouped('b','M')],[grouped('a','M'),grouped('b','L','other')],[grouped('parent','M'),grouped('b','L')]]){const sql={exec:(query:string)=>({toArray:()=>query.includes('count(*)')?[{n:records.length}]:records})};const result=feedSnapshot(sql);assert.equal(result.offers.length,0);assert.equal(result.errors.length,2);}const records=[grouped('a','M'),grouped('b','L')],sql={exec:(query:string)=>({toArray:()=>query.includes('count(*)')?[{n:2}]:records})};assert.equal(feedSnapshot(sql).offers.length,2);});
