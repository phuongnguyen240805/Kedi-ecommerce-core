import {Hono} from 'hono';
import {authMiddleware,adminOnly} from '../middleware/auth';
import {ApiError,type HonoEnv} from '../types';
import {feedOffer,openAiRecord,googleItem,escapeFeedXml} from '../lib/product-feeds';
export const feeds=new Hono<HonoEnv>();
feeds.get('/:format',async c=>{
 if(c.env.FEEDS_ENABLED!=='true')throw ApiError.notFound('Feed is not enabled');
 const format=c.req.param('format');if(!['openai.jsonl','google.xml'].includes(format))throw ApiError.notFound('Unknown feed');
 if(!c.env.STORE_URL)throw ApiError.serviceUnavailable('Storefront URL is not configured');
 const {offers,generated_at}=await c.var.db.feedSnapshot();let index=-1;
 const encoder=new TextEncoder(),stream=new ReadableStream<Uint8Array>({pull(controller){
  if(format==='google.xml'&&index===-1){index=0;controller.enqueue(encoder.encode(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${escapeFeedXml(c.env.STORE_NAME||new URL(c.env.STORE_URL!).hostname)}</title><link>${escapeFeedXml(c.env.STORE_URL!)}</link><description>Merchant product data</description>`));return;}
  if(index===-1)index=0;
  if(index<offers.length){const offer=offers[index++];controller.enqueue(encoder.encode(format==='openai.jsonl'?JSON.stringify(openAiRecord(offer))+'\n':googleItem(offer)));return;}
  if(format==='google.xml')controller.enqueue(encoder.encode('</channel></rss>'));controller.close();
 }});
 return new Response(stream,{headers:{'Content-Type':format==='openai.jsonl'?'application/x-ndjson; charset=utf-8':'application/xml; charset=utf-8','Cache-Control':'no-cache','X-Feed-Generated-At':generated_at}});
});
feeds.use('*',authMiddleware,adminOnly);
feeds.get('/admin/diagnostics',async c=>{const snapshot=await c.var.db.feedSnapshot();return c.json({generated_at:snapshot.generated_at,valid:snapshot.offers.length,errors:snapshot.errors,checkout_eligibility:false});});
feeds.put('/admin/offers/:sku',async c=>{
 const body=await c.req.text();if(body.length>16000)throw ApiError.invalidRequest('Offer too large');const config=feedOffer.parse(JSON.parse(body));
 if(!c.env.STORE_URL)throw ApiError.serviceUnavailable('Storefront URL is not configured');
 return c.json(await c.var.db.feedPut(c.req.param('sku'),config,c.env.STORE_URL));
});
