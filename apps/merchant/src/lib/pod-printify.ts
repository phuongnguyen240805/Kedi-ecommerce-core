import {z} from 'zod';
import type {PodSnapshot,PodLine} from './pod-core';
import {ShippingError} from './smart-shipping';
const order=z.object({id:z.string(),status:z.string(),metadata:z.object({shop_order_id:z.string()}).passthrough(),
 line_items:z.array(z.object({status:z.string()}).passthrough()).optional(),
 shipments:z.array(z.object({carrier:z.string(),number:z.string(),url:z.string().optional(),delivered_at:z.string().optional()}).passthrough()).optional()}).passthrough();
export type PrintifyOrder=z.infer<typeof order>;
export function printifyFulfillmentState(order:PrintifyOrder){
 if(order.status==='canceled')return 'canceled' as const;
 if(order.line_items?.some(l=>['canceled','has-issues'].includes(l.status)))return 'needs_review' as const;
 if(['on-hold','payment-not-received','has-issues','source-check-failed'].includes(order.status))return 'needs_review' as const;
 if(order.shipments?.length)return order.status==='fulfilled'&&order.shipments.every(s=>!!s.delivered_at)?'delivered' as const:'shipped' as const;
 if(['in-production','sending-to-production'].includes(order.status))return 'in_production' as const;
 if(order.status==='pending')return 'accepted' as const;
 return 'needs_review' as const;
}
export class PrintifyClient {
 constructor(private token:string,private shop:string,private transport:typeof fetch=fetch){
  if(!token||!/^\d+$/.test(shop))throw new ShippingError('pod_configuration_missing',503,'Printify is not configured.');
 }
 private async request(path:string,body?:unknown){
  let response:Response;
  const transport=this.transport;
  try{response=await transport(`https://api.printify.com/v1/shops/${this.shop}/${path}`,{
   method:body===undefined?'GET':'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
   headers:{Authorization:`Bearer ${this.token}`,'User-Agent':'KediMuse-Commerce','Content-Type':'application/json'},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });}catch{throw new ShippingError('pod_provider_unknown',502,'Provider response is unknown; reconcile before another submission.');}
  if(response.status>=300&&response.status<400)throw new ShippingError('pod_provider_redirect',502,'Provider redirect rejected.');
  const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000){await reader.cancel();throw new ShippingError('pod_provider_response',502,'Provider response is too large.');}chunks.push(value);}
  let raw:unknown;try{const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}raw=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ShippingError('pod_provider_response',502,'Invalid provider response.');}
  if(!response.ok){
   if(response.status===409){const duplicate=z.object({order:z.object({id:z.string()})}).safeParse(raw);if(duplicate.success)return {duplicate:duplicate.data.order.id};}
   throw new ShippingError('pod_provider_rejected',502,'Provider request was rejected; review the order.');
  }
  return raw;
 }
 async shipping(snapshot:Pick<PodSnapshot,'recipient'|'lines'>){
  for(const line of snapshot.lines){
   const product=z.object({blueprint_id:z.number(),print_provider_id:z.number(),variants:z.array(z.object({id:z.number(),cost:z.number().int(),is_enabled:z.boolean()}))})
    .parse(await this.request(`products/${encodeURIComponent(line.mapping.product_id)}.json`));
   const variant=product.variants.find(v=>v.id===line.mapping.variant_id);
   if(product.blueprint_id!==line.mapping.blueprint_id||product.print_provider_id!==line.mapping.print_provider_id||!variant?.is_enabled||variant.cost!==line.mapping.production_cost_minor)
    throw new ShippingError('pod_mapping_changed',409,'Provider mapping or production cost changed; merchant review required.');
  }
  const raw=await this.request('orders/shipping.json',{line_items:snapshot.lines.map(l=>({product_id:l.mapping.product_id,variant_id:l.mapping.variant_id,quantity:l.qty})),address_to:snapshot.recipient});
  return z.object({standard:z.number().int().nonnegative()}).parse(raw).standard;
 }
 async submit(snapshot:PodSnapshot,reference:string,artworkUrl:(line:PodLine)=>Promise<string>){
  const line_items=await Promise.all(snapshot.lines.map(async l=>({blueprint_id:l.mapping.blueprint_id,print_provider_id:l.mapping.print_provider_id,
   variant_id:l.mapping.variant_id,quantity:l.qty,external_id:l.sku,print_areas:{[l.mapping.placement]:await artworkUrl(l)}})));
  const raw=await this.request('orders.json',{external_id:reference,line_items,shipping_method:1,send_shipping_notification:false,address_to:snapshot.recipient});
  const duplicate=z.object({duplicate:z.string()}).safeParse(raw);
  return duplicate.success?this.get(duplicate.data.duplicate,reference):this.verify(raw,reference);
 }
 private verify(raw:unknown,reference:string){const parsed=order.parse(raw);if(parsed.metadata.shop_order_id!==reference)throw new ShippingError('pod_reference_mismatch',409,'Provider order reference does not match.');return parsed;}
 async get(id:string,reference:string){return this.verify(await this.request(`orders/${encodeURIComponent(id)}.json`),reference);}
 async find(reference:string){
  for(let page=1;page<=10;page++){
   const raw=z.object({data:z.array(order)}).parse(await this.request(`orders.json?page=${page}&limit=100`));
   const found=raw.data.filter(o=>o.metadata.shop_order_id===reference);
   if(found.length>1)throw new ShippingError('pod_duplicate_reference',409,'Multiple provider orders match this reference.');
   if(found.length)return found[0];if(raw.data.length<100)return null;
  }
  throw new ShippingError('pod_lookup_incomplete',409,'Provider lookup did not complete.');
 }
}
