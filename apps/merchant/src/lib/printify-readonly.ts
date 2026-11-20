import {z} from 'zod';
import {ShippingError} from './smart-shipping';
import {podMapping} from './pod-core';

const id=z.number().int().positive();
const productId=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const shopSchema=z.object({id,title:z.string(),sales_channel:z.string()});
const productSchema=z.object({
  id:productId,title:z.string(),blueprint_id:id,print_provider_id:id,
  variants:z.array(z.object({id,title:z.string(),cost:z.number().int().nonnegative(),is_enabled:z.boolean()})).max(5000),
  print_areas:z.array(z.object({variant_ids:z.array(id),placeholders:z.array(z.object({position:z.string()}))})),
});
export const printifyPage=z.coerce.number().int().min(1).max(10000);
export const printifyLimit=z.coerce.number().int().min(1).max(50);

/** Deliberately GET-only: does not upload files, publish products or create orders. */
export class PrintifyReadonlyClient {
  constructor(private token:string,private shop:string,private transport:typeof fetch=fetch){
    if(!token||!/^\d{1,30}$/.test(shop))throw new ShippingError('printify_configuration_missing',503,'Configure Printify token and shop ID on the server.');
  }
  private async get(path:string):Promise<unknown>{
    let response:Response;
    const signal=AbortSignal.timeout(15000);
    try{
      // Native Workers fetch must not receive this client as its receiver.
      const transport=this.transport;
      response=await transport(`https://api.printify.com/v1/${path}`,{
        method:'GET',redirect:'manual',signal,
        headers:{Authorization:`Bearer ${this.token}`,'User-Agent':'KediMuse-Commerce','Accept':'application/json'},
      });
    }catch{throw new ShippingError('printify_unavailable',502,'Printify connection failed; retry the read later.');}
    if(!response.ok){
      await response.body?.cancel();
      const code=response.status===401||response.status===403?'printify_access_denied':response.status===404?'printify_not_found':response.status===429?'printify_rate_limited':'printify_unavailable';
      throw new ShippingError(code,response.status===429?503:502,'Printify read failed; verify credentials, shop access and provider availability.');
    }
    const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
    try{
      if(reader)while(true){
        const {done,value}=await reader.read();if(done)break;
        size+=value.length;
        if(size>2_000_000){await reader.cancel();throw Error();}
        chunks.push(value);
      }
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      return JSON.parse(new TextDecoder().decode(bytes));
    }catch{throw new ShippingError('printify_invalid_response',502,'Printify returned an invalid or oversized response.');}
  }
  private parse<T>(schema:z.ZodType<T>,raw:unknown):T{
    const result=schema.safeParse(raw);
    if(!result.success)throw new ShippingError('printify_invalid_response',502,'Printify returned an unsupported response.');
    return result.data;
  }
  async connection(){
    const shops=this.parse(z.array(shopSchema).max(1000),await this.get('shops.json'));
    const selected=shops.find(s=>String(s.id)===this.shop);
    if(!selected)throw new ShippingError('printify_shop_mismatch',409,'Configured shop is not accessible with this token.');
    return {connected:true,shop:selected,mode:'read_only' as const};
  }
  async products(page=1,limit=20){
    page=printifyPage.parse(page);limit=printifyLimit.parse(limit);
    const result=this.parse(z.object({current_page:z.number().int().positive(),last_page:z.number().int().nonnegative(),data:z.array(productSchema).max(50)}),
      await this.get(`shops/${this.shop}/products.json?page=${page}&limit=${limit}`));
    if(result.current_page!==page||result.last_page<page&&result.data.length>0)throw new ShippingError('printify_invalid_response',502,'Printify pagination does not match the requested page.');
    return {items:result.data,page,next_page:page<result.last_page?page+1:null};
  }
  async product(rawId:string){
    const requested=productId.parse(rawId);
    const product=this.parse(productSchema,await this.get(`shops/${this.shop}/products/${encodeURIComponent(requested)}.json`));
    if(product.id!==requested)throw new ShippingError('printify_product_mismatch',502,'Printify returned a different product.');
    return product;
  }
  async checkMapping(raw:unknown,now=Date.now()){
    const mapping=podMapping.parse(raw),product=await this.product(mapping.product_id);
    const variant=product.variants.find(v=>v.id===mapping.variant_id);
    const reasons:string[]=[];
    if(product.blueprint_id!==mapping.blueprint_id)reasons.push('blueprint_mismatch');
    if(product.print_provider_id!==mapping.print_provider_id)reasons.push('print_provider_mismatch');
    if(!variant)reasons.push('variant_missing');
    else{
      if(!variant.is_enabled)reasons.push('variant_disabled');
      if(variant.cost!==mapping.production_cost_minor)reasons.push('production_cost_changed');
    }
    if(!product.print_areas.some(a=>a.variant_ids.includes(mapping.variant_id)&&a.placeholders.some(p=>p.position===mapping.placement)))reasons.push('placement_unavailable');
    if(mapping.cost_verified_until<=now)reasons.push('cost_verification_expired');
    return {valid:reasons.length===0,reasons,product_id:product.id,variant_id:mapping.variant_id,
      production_cost_minor:variant?.cost??null,currency_verification_required:true,
      scope:'provider_mapping_only',saved:false,production_enabled:false};
  }
}
