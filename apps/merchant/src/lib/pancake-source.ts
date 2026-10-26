import { z } from '@hono/zod-openapi';

const identifier = z.union([z.string().min(1), z.number().int()]).transform(String);
export const warehouseSchema = z.object({
  id: identifier, name: z.string().min(1), address: z.string().nullish(),
  full_address: z.string().nullish(), allow_create_order: z.boolean().optional(),
});
export const variationSchema = z.object({
  id: identifier, product_id: identifier, custom_id: z.string().nullish(),
  display_id: identifier.nullish(), retail_price: z.number().finite().nonnegative(),
  retail_price_by_currency: z.array(z.object({currency:z.string(), retailPriceByCurrency:z.union([z.string(),z.number()])})).optional(),
  images: z.array(z.string()).nullish(), barcode: z.string().nullish(),
  is_locked: z.boolean().optional(), is_hidden: z.boolean().optional(), is_removed: z.boolean().optional(),
  weight: z.number().finite().nonnegative().max(1_000_000).nullish(),
  fields: z.array(z.object({name:z.string(),value:z.string()})).optional(),
  variations_warehouses: z.array(z.object({warehouse_id:identifier,remain_quantity:z.number().finite()})),
  product: z.object({name:z.string().min(1), display_id:identifier.nullish(), image:z.string().nullish(),
    note_product:z.string().nullish(), is_published:z.boolean().nullish()}),
});
export type PosVariation = z.infer<typeof variationSchema>;
export type PosWarehouse = z.infer<typeof warehouseSchema>;
export type SyncProduct = {id:string;sourceId:string;title:string;description:string;handle:string;status:'active'|'draft';image:string|null};
export type SyncVariant = {variantType?:'physical'|'digital'|'ai_tokens';id:string;sourceId:string;productId:string;sku:string;sourceSku:string|null;title:string;price:number;image:string|null;barcode:string|null;weightG:number;quantity:number;status:'active'|'draft'};
export type SyncIssue = {variation_id:string;code:string};
export type PancakeSnapshot = {shopId:string;token:string;full:boolean;warehouse:PosWarehouse & {targetId:string};products:SyncProduct[];variants:SyncVariant[];issues:SyncIssue[]};
export type PosConfig = {PANCAKE_BASE_URL?:string;PANCAKE_SHOP_ID?:string;PANCAKE_API_KEY?:string;PANCAKE_WAREHOUSE_ID?:string};

export class PancakeError extends Error {
  constructor(public code:string,message:string){super(message);}
}
export function getPosConfig(env:PosConfig) {
  if(!env.PANCAKE_API_KEY||!env.PANCAKE_SHOP_ID||!env.PANCAKE_WAREHOUSE_ID)
    throw new PancakeError('configuration','Pancake API key, shop and warehouse must be configured');
  const base=env.PANCAKE_BASE_URL||'https://pos.pages.fm/api/v1';
  if(base.replace(/\/$/,'')!=='https://pos.pages.fm/api/v1'||!/^\d+$/.test(env.PANCAKE_SHOP_ID))
    throw new PancakeError('configuration','Invalid Pancake configuration');
  return {base:base.replace(/\/$/,''),shopId:env.PANCAKE_SHOP_ID,key:env.PANCAKE_API_KEY,warehouseId:env.PANCAKE_WAREHOUSE_ID};
}

// Keep upstream error text and URLs out of logs: api_key is a query parameter.
export async function posGet(config:ReturnType<typeof getPosConfig>,path:string,query:Record<string,string>={}) {
  const url=new URL(`${config.base}/shops/${encodeURIComponent(config.shopId)}/${path}`);
  url.searchParams.set('api_key',config.key);
  for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
  let response:Response;
  try{response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});}
  catch(error){
    const message=error instanceof Error?error.message:'Unknown fetch failure';
    const safe=message.replaceAll(config.key,'[REDACTED]').replaceAll(encodeURIComponent(config.key),'[REDACTED]').replace(/https?:\/\/\S+/g,'[URL]').slice(0,200);
    console.error(JSON.stringify({event:'pancake.fetch_failed',reason:safe}));
    throw new PancakeError('upstream','Pancake request failed');
  }
  if(!response.ok){await response.body?.cancel();throw new PancakeError('upstream',`Pancake returned HTTP ${response.status}`);}
  // Bound both the declared and streamed body, before parsing JSON.
  const reader=response.body?.getReader();if(!reader)throw new PancakeError('schema','Pancake response has no body');
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
    if(length>2_000_000){await reader.cancel();throw new PancakeError('schema','Pancake response exceeds size limit');}chunks.push(value);}}
  catch(error){if(error instanceof PancakeError)throw error;throw new PancakeError('upstream','Pancake response read failed');}
  const joined=new Uint8Array(length);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(joined)) as unknown;}catch{throw new PancakeError('schema','Invalid Pancake JSON');}
}
export async function readPos(env:PosConfig) {
  const config=getPosConfig(env);
  const warehouseResult=z.object({success:z.literal(true),data:z.array(warehouseSchema)}).safeParse(await posGet(config,'warehouses'));
  if(!warehouseResult.success)throw new PancakeError('schema','Invalid Pancake warehouse response');
  const warehouse=warehouseResult.data.data.find(w=>w.id===config.warehouseId);
  if(!warehouse||warehouse.allow_create_order===false)throw new PancakeError('warehouse','Configured Pancake warehouse is unavailable');
  const schema=z.object({success:z.literal(true),data:z.array(variationSchema),total_pages:z.number().int().min(0).max(20),
    total_entries:z.number().int().min(0).max(600),page_number:z.number().int().positive()});
  const variations:PosVariation[]=[];let total:number|undefined;let pages:number|undefined;
  for(let page=1;page<=(pages??1);page++){
    const result=schema.safeParse(await posGet(config,'products/variations',{page_size:'30',page_number:String(page)}));
    if(!result.success)throw new PancakeError('schema','Invalid Pancake catalog or catalog exceeds 600-variant limit');
    const body=result.data;
    if(body.page_number!==page||(total!==undefined&&(body.total_entries!==total||body.total_pages!==pages)))
      throw new PancakeError('pagination','Pancake catalog changed while reading; retry sync');
    total=body.total_entries;pages=body.total_pages;variations.push(...body.data);
  }
  if(variations.length!==total||new Set(variations.map(v=>v.id)).size!==variations.length)
    throw new PancakeError('pagination','Incomplete or duplicate Pancake catalog; previous data retained');
  return {shopId:config.shopId,warehouse,variations};
}

export async function stablePosId(shopId:string,kind:string,sourceId:string) {
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`pancake:${shopId}:${kind}:${sourceId}`)));
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function imageUrl(value:string|undefined|null){try{const u=new URL(value||'');return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
export async function normalizePos(shopId:string,warehouse:PosWarehouse,rows:PosVariation[],token:string,full=true,variantType:'physical'|'digital'|'ai_tokens'='physical'):Promise<PancakeSnapshot>{
  const products=new Map<string,SyncProduct>();const variants:SyncVariant[]=[];const issues:SyncIssue[]=[];
  const candidates=rows.map(v=>v.custom_id||(/[^\d]/.test(v.display_id||'')?v.display_id:null));
  const counts=new Map<string,number>();for(const sku of candidates)if(sku)counts.set(sku,(counts.get(sku)||0)+1);
  for(let index=0;index<rows.length;index++){
    const v=rows[index];const productId=await stablePosId(shopId,'product',v.product_id);
    const priceCurrency=v.retail_price_by_currency?.find(p=>p.currency.toUpperCase()==='VND');
    const price=priceCurrency?Number(priceCurrency.retailPriceByCurrency):v.retail_price;
    if(!Number.isSafeInteger(price)||price<0)throw new PancakeError('price','Pancake VND price must be a nonnegative integer');
    const stockRows=v.variations_warehouses.filter(w=>w.warehouse_id===warehouse.id);
    if(stockRows.length>1)throw new PancakeError('schema','Duplicate warehouse stock rows');
    const stock=stockRows[0]?.remain_quantity??0;
    const unavailable=v.is_locked||v.is_hidden||v.is_removed||v.product.is_published===false;
    const status=price>0&&!unavailable&&Number.isInteger(stock)?'active':'draft';
    if(price===0)issues.push({variation_id:v.id,code:'zero_price'});
    if(!stockRows.length)issues.push({variation_id:v.id,code:'warehouse_stock_missing'});
    if(!Number.isInteger(stock))issues.push({variation_id:v.id,code:'fractional_stock_requires_unit_mapping'});
    const image=v.images?.map(imageUrl).find(Boolean)||imageUrl(v.product.image);
    if(!image)issues.push({variation_id:v.id,code:'image_missing'});
    const candidate=candidates[index];const sku=candidate&&counts.get(candidate)===1?candidate:`POS-${shopId}-${v.id}`;
    if(!candidate||counts.get(candidate)!==1)issues.push({variation_id:v.id,code:'source_sku_missing_or_duplicate'});
    const existing=products.get(v.product_id);
    if(!existing){
      const slug=v.product.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'san-pham';
      products.set(v.product_id,{id:productId,sourceId:v.product_id,title:v.product.name,description:v.product.note_product||'',
        handle:`${slug}-${productId}`,status,image});
    }else{
      if(status==='draft')existing.status='draft';
      if(!existing.image)existing.image=image;
    }
    variants.push({variantType,id:await stablePosId(shopId,'variation',v.id),sourceId:v.id,productId,sku,sourceSku:candidate||null,
      title:v.fields?.map(f=>`${f.name}: ${f.value}`).join(' / ')||v.product.name,price,image,barcode:v.barcode||null,
      weightG:v.weight?Math.ceil(v.weight):0,quantity:Math.max(0,Math.floor(stock)),status});
  }
  return {shopId,token,full,warehouse:{...warehouse,targetId:await stablePosId(shopId,'warehouse',warehouse.id)},
    products:[...products.values()],variants,issues};
}
