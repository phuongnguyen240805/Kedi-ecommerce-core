import { merchantObjectName } from './stores';
import type { MerchantDO } from '../do';
import type { Env } from '../types';
import { PancakeError, getPosConfig, readPos, normalizePos } from './pancake-source';
import { readMcpCatalog } from '../integrations/pancake/mcp-source';
import { accessToken, integrationStub } from '../integrations/ctxlayer/oauth';
import { integrationConfig, IntegrationError } from '../integrations/ctxlayer/config';
import type { RunContext } from '../integrations/pancake/sync-runs';

// Cron has no incoming origin. Purge catalog namespaces across cached origins.
export async function purgePosCatalogCache(kv:KVNamespace) {
  let cursor:string|undefined;
  do{
    const page=await kv.list({prefix:'cache:',...(cursor?{cursor}:{})});
    const keys=page.keys.filter(key=>{
      try{const path=new URL(key.name.slice(6)).pathname;return /^\/(?:v1|ucp\/v1)\/(?:products|categories)(?:\/|$)/.test(path)||path==='/.well-known/ucp';}catch{return false;}
    });
    for(const key of keys)await kv.delete(key.name);
    cursor=page.list_complete?undefined:page.cursor;
  }while(cursor);
}
export async function syncPancake(env:Env, options:{limitProducts?:number;trigger?:'manual'|'cron';actor?:string}={}) {
  if(env.PANCAKE_CATALOG_SOURCE==='ctxlayer_mcp')return syncViaGateway(env,options);
  if(env.PANCAKE_CATALOG_SOURCE&&env.PANCAKE_CATALOG_SOURCE!=='direct')throw new PancakeError('configuration','Invalid catalog source');
  const config=getPosConfig(env);
  const stub=env.MERCHANT.get(env.MERCHANT.idFromName(merchantObjectName(env)));
  const token=crypto.randomUUID();
  if(!await stub.acquirePancakeSync(config.shopId,token))throw new PancakeError('busy','A Pancake sync is already running');
  try{
    const source=await readPos(env);
    const selected=options.limitProducts?new Set([...new Set(source.variations.map(v=>v.product_id))].slice(0,options.limitProducts)):null;
    const variations=selected?source.variations.filter(v=>selected.has(v.product_id)):source.variations;
    const snapshot=await normalizePos(source.shopId,source.warehouse,variations,token,!selected,env.PANCAKE_VARIANT_TYPE || 'physical');
    const report=await stub.applyPancakeSync(snapshot);
    try{await purgePosCatalogCache(env.KV_CACHE);}catch{
      // The database commit remains successful; report cache degradation separately.
      return {...report,cache_invalidated:false};
    }
    return {...report,cache_invalidated:true};
  }catch(error){
    const code=error instanceof PancakeError?error.code:'storage';
    await stub.failPancakeSync(config.shopId,token,code);
    if(error instanceof PancakeError)throw error;
    throw new PancakeError('storage','Pancake sync could not be committed; previous catalog retained');
  }
}
export type PancakeSyncStub=Pick<MerchantDO,'acquirePancakeSync'|'applyPancakeSync'|'failPancakeSync'>;

async function syncViaGateway(env:Env,options:{limitProducts?:number;trigger?:'manual'|'cron';actor?:string}) {
  const stub=integrationStub(env);
  let run:RunContext|undefined;
  try {
    const config=integrationConfig(env);
    if(!env.PANCAKE_SHOP_ID||!env.PANCAKE_WAREHOUSE_ID)throw new IntegrationError('mcp_configuration');
    const auth=await accessToken(env);
    run={id:crypto.randomUUID(),shop:env.PANCAKE_SHOP_ID,config:config.fingerprint,generation:auth.generation,trigger:options.trigger||'manual',actor:options.actor||(options.trigger==='cron'?'scheduled':'admin-api-key')};
    if(!await stub.beginPancakeMcpRun(run))throw new PancakeError('busy','A Pancake sync is already running');
    const result=await readMcpCatalog(env);
    if(result.generation!==run.generation||result.config!==run.config)throw new IntegrationError('mcp_connection_changed');
    const {source}=result;
    const selected=options.limitProducts?new Set([...new Set(source.variations.map(v=>v.product_id))].slice(0,options.limitProducts)):null;
    const rows=selected?source.variations.filter(v=>selected.has(v.product_id)):source.variations;
    const snapshot=await normalizePos(source.shopId,source.warehouse,rows,run.id,!selected,env.PANCAKE_VARIANT_TYPE||'physical');
    const report=await stub.applyPancakeMcpRun(snapshot,run);
    try {await purgePosCatalogCache(env.KV_CACHE);return {...report,cache_invalidated:true};}
    catch {await stub.warnPancakeMcpRun(run.id).catch(()=>{});return {...report,cache_invalidated:false};}
  } catch(error) {
    const code=error instanceof IntegrationError?error.code:error instanceof PancakeError?error.code:'mcp_storage';
    if(run)await stub.failPancakeMcpRun(run,code).catch(()=>{});
    throw new PancakeError(code,'Gateway catalog sync failed; previous catalog retained');
  }
}
