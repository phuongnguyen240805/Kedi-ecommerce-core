import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interpretShopping} from '../src/lib/shopping-ai';
test('AI extracts only search intent with fixed endpoint, no tools or persisted conversation',async()=>{
 let sent:Record<string,unknown>={};
 const fetcher:typeof fetch=async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init?.redirect,'manual');sent=JSON.parse(String(init?.body));return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({query:'cat shirt'})}]}]});};
 assert.equal(await interpretShopping('tôi cần áo mèo','fixture-key','configured-model',fetcher),'cat shirt');assert.equal(sent.store,false);assert.equal(sent.model,'configured-model');assert.equal(sent.tools,undefined);
});
test('AI rejects refusals, incomplete responses, price injection and oversized output',async()=>{
 const fixture=(value:unknown):typeof fetch=>async()=>Response.json(value);
 await assert.rejects(interpretShopping('cat','key','model',fixture({status:'incomplete',output:[]})));
 await assert.rejects(interpretShopping('cat','key','model',fixture({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]})));
 await assert.rejects(interpretShopping('cat','key','model',fixture({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"query":"cat","price":1}'}]}]})));
 await assert.rejects(interpretShopping('cat','key','model',async()=>new Response('x'.repeat(65000))));
});
