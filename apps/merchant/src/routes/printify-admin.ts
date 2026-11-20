import {Hono} from 'hono';
import {z} from 'zod';
import type {HonoEnv} from '../types';
import {ShippingError} from '../lib/smart-shipping';
import {PrintifyReadonlyClient,printifyPage,printifyLimit} from '../lib/printify-readonly';
import {podMapping} from '../lib/pod-core';

/** Mounted after the existing admin authentication, before the POD activation gate. */
export function printifyAdmin(transport:typeof fetch=fetch){
  const api=new Hono<HonoEnv>();
  api.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
  api.onError((error,c)=>{
    if(error instanceof ShippingError)return c.json({error:{code:error.code,message:error.message}},error.status as 409|502|503);
    if(error instanceof z.ZodError)return c.json({error:{code:'invalid_request',message:'Invalid Printify query or mapping.'}},400);
    return c.json({error:{code:'printify_unavailable',message:'Printify read failed.'}},502);
  });
  const client=(env:HonoEnv['Bindings'])=>new PrintifyReadonlyClient(env.PRINTIFY_API_TOKEN||'',env.PRINTIFY_SHOP_ID||'',transport);
  api.get('/readiness',async c=>{
    await c.var.db.podInit();
    const [count]=await c.var.db.query<{n:number}>("SELECT COUNT(*) n FROM pod_mappings WHERE json_extract(config,'$.enabled')=1",[]);
    return c.json({storage_configured:!!c.env.IMAGES,provider_configured:!!c.env.PRINTIFY_API_TOKEN&&!!c.env.PRINTIFY_SHOP_ID,
      signing_configured:(c.env.ORDER_TOKEN_SECRET?.length||0)>=32,stripe_configured:!!c.env.STRIPE_SECRET_KEY,
      pod_enabled:c.env.POD_ENABLED==='true',submit_enabled:c.env.POD_SUBMIT_ENABLED==='true',account_verified:c.env.POD_ACCOUNT_AUTOMATION_VERIFIED==='true',active_mappings:Number(count?.n||0)});
  });
  api.get('/mappings',async c=>{await c.var.db.podInit();return c.json({items:await c.var.db.query('SELECT sku,version,config FROM pod_mappings ORDER BY sku LIMIT 100',[])});});
  api.get('/connection',async c=>c.json(await client(c.env).connection()));
  api.get('/products',async c=>{
    const page=printifyPage.parse(c.req.query('page')??1),limit=printifyLimit.parse(c.req.query('limit')??20);
    return c.json(await client(c.env).products(page,limit));
  });
  api.get('/products/:id',async c=>c.json(await client(c.env).product(c.req.param('id'))));
  api.post('/:operation',async c=>{
    const operation=c.req.param('operation');if(!['mapping-check','mapping-draft'].includes(operation))return c.notFound();
    const reader=c.req.raw.body?.getReader();if(!reader)return c.json({error:'JSON mapping required'},400);
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>64000){await reader.cancel();return c.json({error:'Mapping exceeds 64 KB'},413);}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let raw:unknown;try{raw=JSON.parse(new TextDecoder().decode(bytes));}catch{return c.json({error:'Invalid JSON'},400);}
    if(operation==='mapping-check')return c.json(await client(c.env).checkMapping(raw));
    const input=z.object({sku:z.string().trim().min(1).max(150),currency_confirmed:z.literal(true),mapping:podMapping}).strict().parse(raw);
    if(input.mapping.enabled)return c.json({error:'Draft mapping cannot enable production'},409);
    const checked=await client(c.env).checkMapping(input.mapping);
    if(!checked.valid)return c.json({error:'Provider mapping changed',reasons:checked.reasons},409);
    const saved=await c.var.db.podSaveDraft(input.sku,input.mapping,c.var.auth.sub||'admin-api-key');
    return c.json({...saved,sku:input.sku},201);
  });
  return api;
}
