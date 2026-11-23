import {z} from 'zod';
import {ShippingError} from './smart-shipping';

export const podId=z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/);
export const podStoreId=z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const podHash=z.string().regex(/^[a-f0-9]{64}$/);
export const podEvidence=z.string().trim().min(10).max(1000);
export const podActor=z.string().trim().min(1).max(254);
const dimension=z.number().int().min(100).max(10000);
export const podPrintSpec=z.object({
 sku:z.string().min(1).max(150),shop_id:z.string().regex(/^\d{1,30}$/),
 blueprint_id:z.number().int().positive(),print_provider_id:z.number().int().positive(),variant_id:z.number().int().positive(),
 // The first production scope is flattened front/back DTG/DTF. Other techniques need their own validation.
 placements:z.array(z.object({position:z.enum(['front','back']),decoration_method:z.enum(['dtg','dtf']),
  width_px:dimension,height_px:dimension,width_in:z.number().positive().max(100),height_in:z.number().positive().max(100),
  min_dpi:z.number().min(72).max(600),safe_inset_px:z.number().int().nonnegative().max(2000),
  bleed_policy:podEvidence,physical_evidence:podEvidence,
 }).strict()).min(1).max(2),
 valid_until:z.number().int().positive(),catalog_hash:podHash,
}).strict().superRefine((spec,ctx)=>{
 if(new Set(spec.placements.map(p=>p.position)).size!==spec.placements.length)ctx.addIssue({code:'custom',message:'Duplicate placement'});
 for(const p of spec.placements)if(p.width_px*p.height_px>40_000_000||p.safe_inset_px*2>=Math.min(p.width_px,p.height_px)||Math.abs(p.width_px/p.height_px-p.width_in/p.height_in)>0.01||Math.min(p.width_px/p.width_in,p.height_px/p.height_in)<p.min_dpi)ctx.addIssue({code:'custom',message:'Invalid physical print geometry or resolution'});
});
export type PodPrintSpec=z.infer<typeof podPrintSpec>;
export const podSnapshotInput=z.object({cart_id:z.string().uuid(),sku:z.string().min(1).max(150),spec_id:z.string().uuid(),
 design_id:podId,design_version:z.number().int().positive(),renderer_version:z.literal('flattened-canvas-v1'),
 assets:z.array(z.object({position:z.enum(['front','back']),artwork_id:z.string().uuid()}).strict()).min(1).max(2),
 rights_accepted:z.literal(true),
}).strict();
export type PodSnapshotInput=z.infer<typeof podSnapshotInput>;
export type PodSealedAsset={position:'front'|'back';artwork_id:string;object_key:string;sha256:string;width:number;height:number;size:number};
export type PodDesignSnapshot={id:string;store_id:string;cart_id:string;sku:string;spec_id:string;spec:PodPrintSpec;
 mapping_version:string;design_id:string;design_version:number;renderer_version:'flattened-canvas-v1';assets:PodSealedAsset[];sealed_at:number;hash:string};
export const podOperation=z.enum(['media_upload','create_product','create_order','send_to_production']);
export type PodOperation=z.infer<typeof podOperation>;
export function podFail(code:string,message='Custom print requires merchant review.'):never{throw new ShippingError(code,409,message);}
export function canonicalPod(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonicalPod).join(',')+']';
 const object=value as Record<string,unknown>;
 return '{'+Object.keys(object).sort().filter(k=>object[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonicalPod(object[k])).join(',')+'}';
}
export async function podSha(value:string|Uint8Array){
 const input=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',input)),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function podReadBytes(body:ReadableStream<Uint8Array>|null,max:number){
 const reader=body?.getReader();if(!reader)podFail('pod_body_missing');
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();podFail('pod_body_too_large');}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
