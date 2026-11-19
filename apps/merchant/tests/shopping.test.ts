import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalOffer} from '../src/lib/product-feeds';
import {shoppingSearch,selectedOffer,shoppingSelection,signShopping,verifyShopping} from '../src/lib/shopping';
const offer=canonicalOffer({config:JSON.stringify({title:'Custom cat shirt',description:'Soft cotton',brand:'Test',seller_name:'Test',url:'https://shop.test/shirt',image_url:'https://shop.test/shirt.png',currency:'USD',store_country:'US',target_countries:['US'],mode:'pod',approved:true,availability_verified_until:Date.now()+60000,identifier_exists:false}),variant_id:'v',product_id:'p',variant_status:'active',product_status:'active',price_minor:2500,decimal_places:2,pod_available:1});
const selection={item_id:'v',qty:2,country:'US'},secret='s'.repeat(40);
test('shopping searches only current destination offers and enforces server product constraints',()=>{
 assert.equal(shoppingSearch([offer],'CAT cotton','US').length,1);assert.equal(shoppingSearch([offer],'cat','VN').length,0);
 assert.equal(shoppingSearch([{...offer,availability:'out_of_stock'}],'','US').length,0);
 assert.equal(selectedOffer([offer],selection).price,'25.00 USD');
 assert.throws(()=>selectedOffer([{...offer,mode:'stock'}],selection));assert.throws(()=>selectedOffer([offer],{...selection,country:'VN'}));
 assert.throws(()=>shoppingSelection.parse({...selection,price:1}));assert.throws(()=>shoppingSelection.parse({...selection,qty:100}));
});
test('capabilities bind purpose/store and reject forged, expired or weak-key tokens',async()=>{
 const token=await signShopping(secret,'kedimuse','shopping-cart',selection);
 assert.deepEqual((await verifyShopping(secret,'kedimuse','shopping-cart',token)).selection,selection);
 await assert.rejects(verifyShopping(secret,'other','shopping-cart',token));await assert.rejects(verifyShopping(secret,'kedimuse','shopping-handoff',token));
 await assert.rejects(verifyShopping('x'.repeat(40),'kedimuse','shopping-cart',token));await assert.rejects(signShopping('weak','kedimuse','shopping-cart',selection));
 await assert.rejects(verifyShopping(secret,'kedimuse','shopping-cart',token.slice(0,30)+'forged'));
});
