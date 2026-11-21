import {Hono} from 'hono';
import {authMiddleware,adminOnly} from '../middleware/auth';
import {ApiError,type HonoEnv} from '../types';
import {feedOffer,openAiRecord,googleItem,escapeFeedXml} from '../lib/product-feeds';
export const feeds=new Hono<HonoEnv>();
feeds.get('/:format',async c=>{
 if(c.env.FEEDS_ENABLED!=='true')throw ApiError.notFound('Feed is not enabled');
 const format=c.req.param('format');if(!['openai.jsonl','google.xml'].includes(format))throw ApiError.notFound('Unknown feed');
 if(!c.env.STORE_URL)throw ApiError.serviceUnavailable('Storefront URL is not configured');
 return renderFeed(c,format);
});
async function renderFeed(c:import('hono').Context<HonoEnv>,format:string){
 const snapshot=await c.var.db.feedSnapshot(),offers=snapshot.offers.filter(o=>o.mode!=='pod'||c.env.POD_ENABLED==='true'),generated_at=snapshot.generated_at;let index=-1;
 const encoder=new TextEncoder(),stream=new ReadableStream<Uint8Array>({pull(controller){
  if(format==='google.xml'&&index===-1){index=0;controller.enqueue(encoder.encode(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${escapeFeedXml(c.env.STORE_NAME||new URL(c.env.STORE_URL!).hostname)}</title><link>${escapeFeedXml(c.env.STORE_URL!)}</link><description>Merchant product data</description>`));return;}
  if(index===-1)index=0;
  if(index<offers.length){const offer=offers[index++];controller.enqueue(encoder.encode(format==='openai.jsonl'?JSON.stringify(openAiRecord(offer))+'\n':googleItem(offer)));return;}
  if(format==='google.xml')controller.enqueue(encoder.encode('</channel></rss>'));controller.close();
 }});
 return new Response(stream,{headers:{'Content-Type':format==='openai.jsonl'?'application/x-ndjson; charset=utf-8':'application/xml; charset=utf-8','Cache-Control':'no-cache','X-Feed-Generated-At':generated_at}});
}
feeds.use('*',authMiddleware,adminOnly,async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
feeds.get('/admin/offers',async c=>{await c.var.db.feedSnapshot();const cursor=(c.req.query('cursor')||'').slice(0,200);const rows=await c.var.db.query<{sku:string;id:string;title:string;config:string|null}>("SELECT v.sku,v.id,COALESCE(v.title,p.title) title,f.config FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN feed_offers f ON f.sku=v.sku WHERE v.sku>? ORDER BY v.sku LIMIT 101",[cursor]);return c.json({store_url:c.env.STORE_URL||null,items:rows.slice(0,100).map(r=>({...r,config:r.config?JSON.parse(r.config):null})),next_cursor:rows.length>100?rows[99].sku:null});});
feeds.get('/admin/preview-records',async c=>{const snapshot=await c.var.db.feedSnapshot(),offers=snapshot.offers.filter(o=>o.mode!=='pod'||c.env.POD_ENABLED==='true');return c.json({generated_at:snapshot.generated_at,total:offers.length,sampled:Math.min(5,offers.length),openai:offers.slice(0,5).map(openAiRecord),google:offers.slice(0,5).map(googleItem)});});
feeds.get('/admin/preview/:format',async c=>{const format=c.req.param('format');if(!['openai.jsonl','google.xml'].includes(format))throw ApiError.notFound('Unknown feed');if(!c.env.STORE_URL)throw ApiError.serviceUnavailable('Storefront URL is not configured');const result=await renderFeed(c,format);result.headers.set('Cache-Control','private, no-store');return result;});
feeds.get('/admin/diagnostics',async c=>{const snapshot=await c.var.db.feedSnapshot();return c.json({generated_at:snapshot.generated_at,valid:snapshot.offers.filter(o=>o.mode!=='pod'||c.env.POD_ENABLED==='true').length,errors:snapshot.errors,deferred_pod_offers:snapshot.offers.filter(o=>o.mode==='pod'&&c.env.POD_ENABLED!=='true').length,feed_enabled:c.env.FEEDS_ENABLED==='true',checkout_eligibility:false,merchant_onboarding_required:true,publication_status:c.env.FEEDS_ENABLED!=='true'?'disabled':!snapshot.offers.length?'empty':snapshot.errors.length?'partial':'ready_for_submission',public_urls:{openai:new URL('/v1/feeds/openai.jsonl',c.req.url).href,google:new URL('/v1/feeds/google.xml',c.req.url).href}});});
feeds.put('/admin/offers/:sku',async c=>{
 const body=await c.req.text();if(body.length>16000)throw ApiError.invalidRequest('Offer too large');const config=feedOffer.parse(JSON.parse(body));
 if(!c.env.STORE_URL)throw ApiError.serviceUnavailable('Storefront URL is not configured');
 return c.json(await c.var.db.feedPut(c.req.param('sku'),config,c.env.STORE_URL));
});
