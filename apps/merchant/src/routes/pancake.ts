import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, type HonoEnv } from '../types';
import { PancakeError } from '../lib/pancake-source';
import { syncPancake } from '../lib/pancake-sync';
import { integrationStub } from '../integrations/ctxlayer/oauth';
import { integrationConfig } from '../integrations/ctxlayer/config';

const app=new OpenAPIHono<HonoEnv>();
app.use('*',authMiddleware,adminOnly);
const response={content:{'application/json':{schema:z.record(z.string(),z.unknown())}},description:'Pancake integration status'};
app.openapi(createRoute({method:'get',path:'/status',tags:['Pancake'],security:[{bearerAuth:[]}],responses:{200:response}}),async c=>{
  const shopId=c.env.PANCAKE_SHOP_ID||'';
  const source=c.env.PANCAKE_CATALOG_SOURCE||'direct';
  const integration=source==='ctxlayer_mcp'?(await integrationStub(c.env).ctxlayerState({op:'get'})).connection:null;
  let mcpConfigured=false;try{mcpConfigured=Boolean(integration?.status==='connected'&&integration.config===integrationConfig(c.env).fingerprint);}catch{}
  const [state]=await c.var.db.query<Record<string,unknown>>('SELECT last_attempt_at,last_completed_at,last_error,warehouse_id,report_json,lease_until FROM pancake_sync_state WHERE shop_id=?',[shopId]);
  return c.json({stock_only:c.env.PANCAKE_STOCK_ONLY==='true',source,connection_status:integration?.status||null,configured:source==='ctxlayer_mcp'?mcpConfigured:Boolean(c.env.PANCAKE_API_KEY&&shopId&&c.env.PANCAKE_WAREHOUSE_ID),shop_id:shopId,
    warehouse_id:c.env.PANCAKE_WAREHOUSE_ID||null,scheduled:c.env.PANCAKE_SYNC_ENABLED==='true',
    running:Number(state?.lease_until||0)>Date.now(),last_attempt_at:state?.last_attempt_at||null,
    last_completed_at:state?.last_completed_at||null,last_error:state?.last_error||null,
    last_report:state?.report_json?JSON.parse(String(state.report_json)):null},200);
});
app.openapi(createRoute({method:'post',path:'/sync',tags:['Pancake'],security:[{bearerAuth:[]}],
  request:{body:{content:{'application/json':{schema:z.object({limit_products:z.number().int().min(1).max(600).optional()})}}}},
  responses:{200:response,409:{description:'Sync is already running'},502:{description:'Pancake sync failed'}}}),async c=>{
  try{return c.json(await syncPancake(c.env,{limitProducts:c.req.valid('json').limit_products,actor:c.var.auth.sub||'admin-api-key'}),200);}
  catch(error){
    if(error instanceof PancakeError)throw new ApiError(`pancake_${error.code}`,error.code==='busy'?409:error.code==='configuration'?400:502,error.message);
    throw new ApiError('pancake_sync_failed',502,'Pancake sync failed');
  }
});
export const adminPancake=app;
app.get('/runs/:id',async c=>{
  const run=await integrationStub(c.env).pancakeMcpRun(c.req.param('id'));
  if(!run)throw ApiError.notFound('Run not found');
  return c.json(run);
});
