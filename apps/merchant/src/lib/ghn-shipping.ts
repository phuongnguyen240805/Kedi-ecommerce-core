import {z} from '@hono/zod-openapi';
import {ShippingError,applySubsidy,type ProviderContext,type ProviderResult,type ShippingProvider,type ShippingConfig} from './smart-shipping';
import {readJson} from './read-json';

export async function ghnRequest(config:ShippingConfig,path:string,body:unknown,signal?:AbortSignal,method:'GET'|'POST'='POST'){
  const host=config.environment==='staging'?'https://dev-online-gateway.ghn.vn':'https://online-gateway.ghn.vn';
  const url=new URL(host+'/shiip/public-api/'+path);
  if(method==='GET')for(const [key,value]of Object.entries(body as Record<string,unknown>))url.searchParams.set(key,String(value));
  let response:Response;
  try{response=await fetch(url,{method,redirect:'manual',signal:signal||AbortSignal.timeout(6000),
    headers:{'Content-Type':'application/json',Token:config.token,ShopId:String(config.shop_id)},...(method==='POST'?{body:JSON.stringify(body)}:{})});}
  catch{throw new ShippingError('ghn_unavailable',502,'GHN không phản hồi. Vui lòng thử lại.');}
  if(!response.ok){
    if(response.status===400&&method==='GET'&&path.startsWith('v2/shipping-order/detail')){
      const error=z.object({code:z.literal(400),message:z.literal('Đơn hàng không tồn tại')}).safeParse(await readJson(new Request('https://internal.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),100000));
      if(error.success)throw new ShippingError('carrier_order_not_found',404,'Hãng xác nhận không tìm thấy vận đơn.');
    }else await response.body?.cancel();
    throw new ShippingError(response.status===401||response.status===403?'ghn_authentication':'ghn_request_failed',502,'GHN từ chối yêu cầu.');
  }
  const reader=response.body?.getReader();if(!reader)throw new ShippingError('ghn_schema',502,'GHN trả về dữ liệu trống.');
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>1_000_000){await reader.cancel();throw new ShippingError('ghn_schema',502,'Dữ liệu GHN quá lớn.');}chunks.push(value);}}
  catch(e){if(e instanceof ShippingError)throw e;throw new ShippingError('ghn_unavailable',502,'Không đọc được báo giá GHN.');}
  const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  try{const parsed=z.object({code:z.literal(200),data:z.unknown()}).parse(JSON.parse(new TextDecoder().decode(bytes)));return parsed.data;}
  catch{throw new ShippingError('ghn_schema',502,'Dữ liệu báo giá GHN không hợp lệ.');}
}
const money=z.number().int().nonnegative().max(2_000_000_000);
const feeSchema=z.object({total:money}).catchall(z.union([money,z.unknown()]));
const leadSchema=z.object({leadtime:z.number().int().positive(),leadtime_order:z.object({to_estimate_date:z.string().datetime({offset:true})}).optional()});
export const ghnProvider:ShippingProvider={code:'ghn',async quote(context:ProviderContext):Promise<ProviderResult>{
  const {request,parcel,signal}=context;
  if(parcel.goods_value_vnd>5_000_000)throw new ShippingError('declared_value_exceeded',422,'Giá trị kiện vượt hạn mức khai giá của dịch vụ GHN.');
  const config=z.object({token:z.string().min(8),shop_id:z.number().int().positive(),from_district_id:z.number().int().positive(),from_ward_code:z.string().min(1),environment:z.enum(['production','staging']),policy:z.custom<import('./smart-shipping').ShippingPolicy>()}).parse(context.config);
  const services=z.array(z.object({service_id:z.number().int(),service_type_id:z.number().int(),short_name:z.string().max(100)})).max(20)
    .safeParse(await ghnRequest(config,'v2/shipping-order/available-services',{shop_id:config.shop_id,from_district:config.from_district_id,to_district:request.destination.district_id},signal));
  if(!services.success)throw new ShippingError('ghn_schema',502,'Danh sách dịch vụ GHN không hợp lệ.');
  // Current GHN fee/leadtime APIs price service_type_id, not legacy service_id.
  const type=parcel.weight_g<20_000?2:5;
  const eligible=services.data.filter(s=>s.service_type_id===type).filter((s,i,a)=>a.findIndex(v=>v.service_type_id===s.service_type_id)===i);
  const results=await Promise.allSettled(eligible.map(async service=>{
    const body={from_district_id:config.from_district_id,from_ward_code:config.from_ward_code,to_district_id:request.destination.district_id,
      to_ward_code:request.destination.ward_code,service_type_id:service.service_type_id,weight:parcel.weight_g,
      length:parcel.length_cm,width:parcel.width_cm,height:parcel.height_cm,insurance_value:parcel.goods_value_vnd,
      ...(type===5?{items:[{name:'Kiện hàng',quantity:1,weight:parcel.weight_g,length:parcel.length_cm,width:parcel.width_cm,height:parcel.height_cm}]}:{})};
    const leadResult=leadSchema.safeParse(await ghnRequest(config,'v2/shipping-order/leadtime',body,signal));
    if(!leadResult.success)throw new ShippingError('ghn_schema',502,'Thời gian giao GHN không hợp lệ.');
    const estimate=leadResult.data.leadtime_order?.to_estimate_date||new Date(leadResult.data.leadtime*1000).toISOString();
    let cod=request.payment_method==='cod'?parcel.goods_value_vnd:0;
    for(let attempt=0;attempt<4;attempt++){
      const feeResult=feeSchema.safeParse(await ghnRequest(config,'v2/shipping-order/fee',{...body,cod_value:cod},signal));
      if(!feeResult.success)throw new ShippingError('ghn_schema',502,'Phí GHN không hợp lệ.');
      const fees=applySubsidy(feeResult.data.total,parcel.goods_value_vnd,config.policy);
      const nextCod=request.payment_method==='cod'?parcel.goods_value_vnd+fees.customer_fee_vnd:0;
      if(nextCod===cod){
        const breakdown:Record<string,number>={};for(const [key,v]of Object.entries(feeResult.data))if(Number.isSafeInteger(v)&&typeof v==='number')breakdown[key]=v;
        return {id:`ghn:${service.service_type_id}`,provider:'ghn',service_type_id:service.service_type_id,service_name:service.short_name,
          currency:'VND' as const,...fees,cod_value_vnd:cod,estimated_delivery_at:estimate,fee_breakdown:breakdown,source:'carrier_api' as const,environment:config.environment};
      }cod=nextCod;
    }
    throw new ShippingError('cod_fee_unstable',502,'Phí COD chưa ổn định. Vui lòng thử lại.');
  }));
  const offers:ProviderResult['offers']=[],warnings:ProviderResult['warnings']=[];
  for(const result of results){if(result.status==='fulfilled')offers.push(result.value);else warnings.push({provider:'ghn',code:result.reason instanceof ShippingError?result.reason.code:'ghn_unavailable'});}
  return {offers,warnings};
}};
