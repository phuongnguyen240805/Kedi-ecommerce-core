import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {PrintifyReadonlyClient} from '../src/lib/printify-readonly';
import {printifyAdmin} from '../src/routes/printify-admin';
import {pod} from '../src/routes/pod';
import {authMiddleware,adminOnly} from '../src/middleware/auth';
import {ApiError,type HonoEnv,type DOStub} from '../src/types';

const product={id:'shirt',title:'Shirt',blueprint_id:12,print_provider_id:2,
  variants:[{id:101,title:'Black / S',cost:1000,is_enabled:true}],
  print_areas:[{variant_ids:[101],placeholders:[{position:'front',images:[{src:'private-artwork'}]}]}]};
const mapping={product_id:'shirt',variant_id:101,blueprint_id:12,print_provider_id:2,placement:'front',
  min_width:1000,min_height:1000,countries:['US'],production_cost_minor:1000,
  cost_verified_until:Date.now()+86400000,minimum_margin_minor:500,tax_bps:0,tax_policy_ref:'merchant-reviewed',currency:'USD',enabled:false};
const client=(raw:unknown)=>new PrintifyReadonlyClient('private-token','123',async()=>Response.json(raw));

test('connection verifies selected shop and returns only selected sanitized account data',async()=>{
  const c=client([{id:123,title:'KediMuse',sales_channel:'custom_integration',secret:'hidden'},{id:999,title:'Other',sales_channel:'etsy'}]);
  assert.deepEqual(await c.connection(),{connected:true,shop:{id:123,title:'KediMuse',sales_channel:'custom_integration'},mode:'read_only'});
  await assert.rejects(client([{id:999,title:'Other',sales_channel:'etsy'}]).connection(),/not accessible/);
});
test('catalog paginates on fixed provider origin and strips artwork and provider URL cursors',async()=>{
  const c=new PrintifyReadonlyClient('private-token','123',async(url,init)=>{
    assert.equal(String(url),'https://api.printify.com/v1/shops/123/products.json?page=2&limit=50');
    assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');
    assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer private-token');
    return Response.json({current_page:2,last_page:3,data:[product],next_page_url:'https://evil.test/steal'});
  });
  const result=await c.products(2,50);assert.equal(result.next_page,3);
  assert.equal(JSON.stringify(result).includes('private-artwork'),false);
  assert.equal(JSON.stringify(result).includes('evil.test'),false);
  assert.equal((await client({current_page:1,last_page:1,data:[]}).products()).next_page,null);
});
test('invalid pagination and product IDs are rejected before network access',async()=>{
  let calls=0;const c=new PrintifyReadonlyClient('secret','123',async()=>{calls++;return Response.json({});});
  for(const [page,limit] of [[0,20],[1,51],[1.5,20],[10001,20]])await assert.rejects(c.products(page,limit));
  await assert.rejects(c.product('../shops'));assert.equal(calls,0);
  assert.throws(()=>new PrintifyReadonlyClient('','123'));
  assert.throws(()=>new PrintifyReadonlyClient('secret','../1'));
});
test('catalog rejects provider page drift and mismatched product identity',async()=>{
  await assert.rejects(client({current_page:2,last_page:2,data:[product]}).products(1),/pagination/);
  await assert.rejects(client({...product,id:'foreign'}).product('shirt'),/different product/);
});
test('mapping checks report drift without saving or enabling production',async()=>{
  const valid=await client(product).checkMapping(mapping);
  assert.equal(valid.valid,true);assert.equal(valid.saved,false);assert.equal(valid.production_enabled,false);
  assert.equal(valid.currency_verification_required,true);
  const drift=await client({...product,blueprint_id:99,print_provider_id:99,variants:[{...product.variants[0],is_enabled:false,cost:1200}],print_areas:[]}).checkMapping({...mapping,cost_verified_until:1});
  assert.deepEqual(drift.reasons,['blueprint_mismatch','print_provider_mismatch','variant_disabled','production_cost_changed','placement_unavailable','cost_verification_expired']);
  const missing=await client({...product,variants:[]}).checkMapping(mapping);assert.ok(missing.reasons.includes('variant_missing'));
});
test('mapping input is strict and does not accept arbitrary paid or price fields',async()=>{
  await assert.rejects(client(product).checkMapping({...mapping,paid:true}));
});
test('provider errors and redirects never disclose raw response or follow Location',async()=>{
  for(const status of [301,401,403,404,429,500]){
    let calls=0;
    const c=new PrintifyReadonlyClient('secret','123',async()=>{calls++;return new Response('secret raw provider response',{status,headers:{Location:'https://evil.test'}});});
    await assert.rejects(c.connection(),e=>{assert.equal(String(e).includes('secret'),false);return true;});assert.equal(calls,1);
  }
});
test('invalid JSON, schema, oversized body and network errors fail with sanitized errors',async()=>{
  for(const transport of [async()=>new Response('not JSON'),async()=>Response.json({token:'secret'}),async()=>new Response('x'.repeat(2_000_001)),async()=>{throw Error('secret upstream');}]){
    await assert.rejects(new PrintifyReadonlyClient('secret','123',transport).connection(),e=>{assert.equal(String(e).includes('secret'),false);return true;});
  }
});

function appFor(role='admin'){
  const app=new Hono<HonoEnv>();
  app.use('*',async(c,next)=>{
    c.set('db',{query:async()=>[{id:'fixture-key',role}]} as unknown as DOStub);await next();
  });
  app.onError((error,c)=>c.json({error:error.message},error instanceof ApiError?error.statusCode as 401|403:500));
  return app;
}
const env={PRINTIFY_API_TOKEN:'private-token',PRINTIFY_SHOP_ID:'123',POD_ENABLED:'false'};
test('admin API reads provider while POD is off and checks admin authorization',async()=>{
  for(const [role,authorization,status] of [['admin','',401],['public','Bearer pk_fixture',403],['admin','Bearer sk_fixture',200]]){
    const app=appFor(role);let calls=0;
    app.use('*',authMiddleware,adminOnly);
    app.route('/printify',printifyAdmin(async()=>{calls++;return Response.json([{id:123,title:'Store',sales_channel:'custom_integration'}]);}));
    const response=await app.request('/printify/connection',{headers:{Authorization:authorization}},env);
    assert.equal(response.status,status);assert.equal(calls,status===200?1:0);
    if(status===200){assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal((await response.text()).includes('private-token'),false);}
  }
});
test('actual POD router exposes configuration diagnostics without opening production routes',async()=>{
  const app=appFor();app.route('/pod',pod);
  assert.equal((await app.request('/pod/admin/printify/connection',{},env)).status,401);
  const headers={Authorization:'Bearer sk_fixture'};
  const connection=await app.request('/pod/admin/printify/connection',{headers},{POD_ENABLED:'false'});
  assert.equal(connection.status,503);assert.equal((await connection.json() as any).error.code,'printify_configuration_missing');
  assert.equal((await app.request('/pod/catalog',{headers},env)).status,503);
  assert.equal((await app.request('/pod/checkout',{method:'POST',headers},env)).status,503);
});
test('API rejects malformed mapping, oversized body and invalid pagination without provider calls',async()=>{
  const app=appFor();let calls=0;app.use('*',authMiddleware,adminOnly);
  app.route('/printify',printifyAdmin(async()=>{calls++;return Response.json(product);}));
  const headers={Authorization:'Bearer sk_fixture'};
  for(const [body,status] of [['{',400],['x'.repeat(64001),413],[JSON.stringify({...mapping,paid:true}),400]]){
    assert.equal((await app.request('/printify/mapping-check',{method:'POST',headers,body},env)).status,status);
  }
  assert.equal((await app.request('/printify/products?limit=51',{headers},env)).status,400);assert.equal(calls,0);
  const result=await app.request('/printify/mapping-check',{method:'POST',headers,body:JSON.stringify(mapping)},env);
  assert.equal(result.status,200);assert.equal((await result.json() as any).saved,false);assert.equal(calls,1);
});
test('mapping draft requires explicit currency verification, rejects activation, and saves only checked data',async()=>{
 const app=appFor();const save=async(sku:string,value:unknown)=>{assert.equal(sku,'POD-S');assert.equal((value as {enabled:boolean}).enabled,false);return {version:'draft',enabled:false};};
 app.use('*',async(c,next)=>{c.set('db',{query:async()=>[{id:'fixture',role:'admin'}],podSaveDraft:save} as unknown as DOStub);await next();});
 app.use('*',authMiddleware,adminOnly);app.route('/printify',printifyAdmin(async()=>Response.json(product)));
 const post=(body:unknown)=>app.request('/printify/mapping-draft',{method:'POST',headers:{Authorization:'Bearer sk_fixture','Content-Type':'application/json'},body:JSON.stringify(body)},env);
 assert.equal((await post({sku:'POD-S',mapping})).status,400);
 assert.equal((await post({sku:'POD-S',currency_confirmed:true,mapping:{...mapping,enabled:true}})).status,409);
 const result=await post({sku:'POD-S',currency_confirmed:true,mapping});assert.equal(result.status,201);assert.equal((await result.json() as any).enabled,false);
});
