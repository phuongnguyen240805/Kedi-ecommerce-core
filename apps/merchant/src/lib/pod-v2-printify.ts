import {z} from 'zod';
import {canonicalPod,podFail,podId,podReadBytes,podSha,type PodPrintSpec,type PodDesignSnapshot} from './pod-v2-model';
import type {PodSnapshot} from './pod-core';

const image=z.object({id:podId,file_name:z.string(),width:z.number().int().positive(),height:z.number().int().positive(),size:z.number().int().positive(),mime_type:z.string()});
export const stagedOrder=z.object({id:podId,status:z.string(),metadata:z.object({shop_order_id:z.string()}).passthrough(),
 address_to:z.record(z.string(),z.unknown()).optional(),
 line_items:z.array(z.object({product_id:z.string(),variant_id:z.number().int(),quantity:z.number().int().positive(),status:z.string().optional(),metadata:z.object({external_id:z.string().optional()}).passthrough().optional()}).passthrough()).min(1),
 shipments:z.array(z.object({carrier:z.string(),number:z.string(),url:z.string().optional(),delivered_at:z.string().nullable().optional()})).optional(),
}).passthrough();
export type StagedOrder=z.infer<typeof stagedOrder>;
export type StagedLine={product_id:string;variant_id:number;quantity:number;external_id:string};
const product=z.object({id:podId,title:z.string(),blueprint_id:z.number(),print_provider_id:z.number(),
 variants:z.array(z.object({id:z.number(),cost:z.number().int().nonnegative(),is_enabled:z.boolean()})),
 print_areas:z.array(z.object({variant_ids:z.array(z.number()),placeholders:z.array(z.object({position:z.string(),decoration_method:z.string().optional(),images:z.array(z.object({id:z.string(),x:z.number(),y:z.number(),scale:z.number(),angle:z.number()}))}))})),
}).passthrough();
export type StagedProduct=z.infer<typeof product>;
export class PodProviderError extends Error{
 constructor(readonly code:string,readonly status?:number,readonly retryAfter=60){super(code);}
}
/** All POST callers must have recorded a durable operation intent first. No automatic POST retries. */
export class StagedPrintifyClient{
 constructor(private token:string,readonly shop:string,private transport:typeof fetch=fetch){if(!token||!/^\d{1,30}$/.test(shop))podFail('pod_provider_configuration');}
 private async request(path:string,body?:unknown):Promise<unknown>{
  const transport=this.transport;let response:Response;
  try{response=await transport('https://api.printify.com/v1/'+path,{method:body===undefined?'GET':'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json','User-Agent':'KediMuse-POD-v2'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw new PodProviderError('provider_outcome_unknown');}
  if(!response.ok){await response.body?.cancel();const retry=Number(response.headers.get('Retry-After'));throw new PodProviderError('provider_http_'+response.status,response.status,Number.isFinite(retry)&&retry>0?Math.min(retry,3600):60);}
  if(!response.body&&(response.status===202||response.status===204))return null;
  const bytes=await podReadBytes(response.body,2_000_000).catch(()=>{throw new PodProviderError('provider_invalid_response');});
  if(!bytes.length&&(response.status===202||response.status===204))return null;
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new PodProviderError('provider_invalid_response');}
 }
 async verifyCatalog(spec:PodPrintSpec){
  if(spec.shop_id!==this.shop)podFail('pod_shop_mismatch');
  const raw=z.object({id:z.number(),variants:z.array(z.object({id:z.number(),placeholders:z.array(z.object({position:z.string(),width:z.number(),height:z.number(),decoration_method:z.string().optional()}).passthrough())}).passthrough())}).passthrough().parse(await this.request(`catalog/blueprints/${spec.blueprint_id}/print_providers/${spec.print_provider_id}/variants.json`));
  const v=raw.variants.find(v=>v.id===spec.variant_id);if(!v)podFail('pod_variant_unavailable');
  const selected=spec.placements.map(p=>{const found=v.placeholders.find(x=>x.position===p.position&&x.decoration_method===p.decoration_method);if(!found||found.width!==p.width_px||found.height!==p.height_px)podFail('pod_catalog_drift');return found;});
  return podSha(canonicalPod({blueprint_id:spec.blueprint_id,print_provider_id:spec.print_provider_id,variant_id:v.id,placements:selected}));
 }
 async catalog(spec:PodPrintSpec){return this.verifyCatalog(spec);}
 async shipping(snapshot:Pick<PodSnapshot,'recipient'|'lines'>,lines?:StagedLine[]){
  const raw=await this.request(`shops/${this.shop}/orders/shipping.json`,{line_items:lines||snapshot.lines.map(l=>({blueprint_id:l.mapping.blueprint_id,print_provider_id:l.mapping.print_provider_id,variant_id:l.mapping.variant_id,quantity:l.qty})),address_to:snapshot.recipient});
  return z.object({standard:z.number().int().nonnegative()}).parse(raw).standard;
 }
 async upload(file_name:string,url:string){const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)podFail('pod_asset_url_invalid');return image.parse(await this.request('uploads/images.json',{file_name,url}));}
 async image(id:string){return image.parse(await this.request(`uploads/${podId.parse(id)}.json`));}
 async createProduct(snapshot:PodDesignSnapshot,images:Record<string,string>,price:number,title:string){
  const spec=snapshot.spec;
  const body={title,description:'Custom print-on-demand item',blueprint_id:spec.blueprint_id,print_provider_id:spec.print_provider_id,visible:false,
   variants:[{id:spec.variant_id,price,is_enabled:true}],
   print_areas:[{variant_ids:[spec.variant_id],placeholders:spec.placements.map(p=>({position:p.position,decoration_method:p.decoration_method,images:[{id:images[p.position],x:0.5,y:0.5,scale:1,angle:0}]}))}],
  };
  return product.parse(await this.request(`shops/${this.shop}/products.json`,body));
 }
 async product(id:string){const result=product.parse(await this.request(`shops/${this.shop}/products/${podId.parse(id)}.json`));if(result.id!==id)podFail('pod_product_id_mismatch');return result;}
 verifyProduct(result:StagedProduct,snapshot:PodDesignSnapshot,images:Record<string,string>,expectedCost:number){
  const spec=snapshot.spec,v=result.variants.find(v=>v.id===spec.variant_id);
  if(result.blueprint_id!==spec.blueprint_id||result.print_provider_id!==spec.print_provider_id||!v?.is_enabled||v.cost!==expectedCost)podFail('pod_product_cost_or_mapping_changed');
  const placeholders=result.print_areas.filter(a=>a.variant_ids.includes(spec.variant_id)).flatMap(a=>a.placeholders);
  if(placeholders.length!==spec.placements.length)podFail('pod_product_artwork_mismatch');
  for(const p of spec.placements){const slot=placeholders.find(x=>x.position===p.position&&x.decoration_method===p.decoration_method),im=slot?.images[0];if(!im||slot!.images.length!==1||im.id!==images[p.position]||im.x!==0.5||im.y!==0.5||im.scale!==1||im.angle!==0)podFail('pod_product_artwork_mismatch');}
  return result;
 }
 async createOrder(reference:string,lines:StagedLine[],recipient:PodSnapshot['recipient']){return stagedOrder.parse(await this.request(`shops/${this.shop}/orders.json`,{external_id:reference,line_items:lines,shipping_method:1,send_shipping_notification:false,address_to:recipient}));}
 async order(id:string){const result=stagedOrder.parse(await this.request(`shops/${this.shop}/orders/${podId.parse(id)}.json`));if(result.id!==id)podFail('pod_order_id_mismatch');return result;}
 verifyOrder(order:StagedOrder,reference:string,lines:StagedLine[],recipient?:PodSnapshot['recipient']){
  if(order.metadata.shop_order_id!==reference||order.line_items.length!==lines.length)podFail('pod_order_reference_mismatch');
  for(const l of lines)if(order.line_items.filter(x=>x.product_id===l.product_id&&x.variant_id===l.variant_id&&x.quantity===l.quantity&&x.metadata?.external_id===l.external_id).length!==1)podFail('pod_order_lines_mismatch');
  if(recipient)for(const key of ['first_name','last_name','country','region','address1','address2','city','zip'] as const)if(String(order.address_to?.[key]||'').trim()!==recipient[key].trim())podFail('pod_order_address_mismatch');
  return order;
 }
 async findOrder(reference:string){
  const matches:StagedOrder[]=[];
  for(let page=1;page<=100;page++){
   const result=z.object({current_page:z.number().int(),last_page:z.number().int().nonnegative(),data:z.array(stagedOrder).max(50)}).parse(await this.request(`shops/${this.shop}/orders.json?page=${page}&limit=50`));
   if(result.current_page!==page||result.last_page<page&&result.data.length>0)podFail('pod_provider_pagination_invalid');
   matches.push(...result.data.filter(o=>o.metadata.shop_order_id===reference));if(matches.length>1)podFail('pod_duplicate_external_orders');
   if(page>=result.last_page)return matches[0]||null;
  }
  podFail('pod_provider_lookup_incomplete');
 }
 async send(id:string){await this.request(`shops/${this.shop}/orders/${podId.parse(id)}/send_to_production.json`,{});return {id};}
}
export function stagedPublicState(order:StagedOrder){
 if(order.status==='canceled')return 'canceled';
 if(order.line_items.some(l=>['canceled','has-issues'].includes(l.status||'')))return 'needs_review';
 if(order.status==='fulfilled'&&order.shipments?.length&&order.shipments.every(s=>s.delivered_at))return 'delivered';
 if(order.shipments?.length)return order.status==='fulfilled'?'shipped':'partially_shipped';
 if(['in-production','sending-to-production'].includes(order.status))return 'in_production';
 if(order.status==='pending')return 'accepted';return 'needs_review';
}
