import {SignJWT,jwtVerify} from 'jose';
import type {DOStub,Env} from '../types';
import {inspectPodPng} from './pod-artwork';
import {canonicalPod,podFail,podReadBytes,podSha,podSnapshotInput,podPrintSpec,type PodDesignSnapshot,type PodSealedAsset} from './pod-v2-model';

/** Stream PNG decompression one scanline at a time, with a strict expected byte count.
 * Pilot supports 8-bit, non-interlaced RGBA. Other PNG formats require a reviewed conversion.
 */
export async function validatePodPrintBytes(bytes:Uint8Array,width:number,height:number,safeInset=0){
 const size=inspectPodPng(bytes);if(size.width!==width||size.height!==height)podFail('pod_canvas_size_mismatch');
 if(bytes[24]!==8||bytes[25]!==6||bytes[26]!==0||bytes[27]!==0||bytes[28]!==0)podFail('pod_png_format_unsupported','Export a non-interlaced RGBA PNG.');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const idats:Uint8Array[]=[];
 for(let offset=8;offset<bytes.length;){const n=view.getUint32(offset);if(new TextDecoder().decode(bytes.subarray(offset+4,offset+8))==='IDAT')idats.push(bytes.subarray(offset+8,offset+8+n));offset+=12+n;}
 const compressed=new ReadableStream<BufferSource>({start(controller){for(const part of idats)controller.enqueue(new Uint8Array(part).buffer);controller.close();}});
 const reader=compressed.pipeThrough(new DecompressionStream('deflate')).getReader();
 const stride=width*4;let previous=new Uint8Array(stride),row=new Uint8Array(stride+1),filled=0,rows=0,visible=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;let offset=0;
  while(offset<value.length){if(rows>=height)podFail('pod_png_expanded_size');const take=Math.min(row.length-filled,value.length-offset);row.set(value.subarray(offset,offset+take),filled);filled+=take;offset+=take;
   if(filled===row.length){const filter=row[0];if(filter>4)podFail('pod_png_filter');const decoded=new Uint8Array(stride);
    for(let i=0;i<stride;i++){const a=i>=4?decoded[i-4]:0,b=previous[i],c=i>=4?previous[i-4]:0;let prediction=0;
     if(filter===1)prediction=a;else if(filter===2)prediction=b;else if(filter===3)prediction=Math.floor((a+b)/2);else if(filter===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);prediction=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
     decoded[i]=(row[i+1]+prediction)&255;
     if(i%4===3&&decoded[i]>0){visible++;const x=Math.floor(i/4);if(safeInset&&(x<safeInset||x>=width-safeInset||rows<safeInset||rows>=height-safeInset))podFail('pod_safe_zone_violation','Artwork crosses the approved safe area.');}
    }
    previous=decoded;rows++;filled=0;
   }
  }
 }}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 if(rows!==height||filled||!visible)podFail('pod_png_empty_or_truncated');return {width,height};
}

export async function loadPodDesign(db:DOStub,store:string,id:string,cart?:string){
 const [row]=await db.query<{body:string}>('SELECT body FROM pod_v2_snapshots WHERE id=? AND store_id=?'+(cart?' AND cart_id=?':''),cart?[id,store,cart]:[id,store]);
 if(!row)podFail('pod_snapshot_missing');const snapshot=JSON.parse(row.body) as PodDesignSnapshot;
 const {hash,...metadata}=snapshot;if(hash!==await podSha(canonicalPod(metadata)))podFail('pod_snapshot_hash_mismatch');
 return snapshot;
}
export async function sealPodDesign(db:DOStub,env:Env,raw:unknown){
 if(!env.IMAGES)podFail('pod_r2_missing','Print artwork storage is not configured.');
 const input=podSnapshotInput.parse(raw),store=env.STORE_ID||'default';
 const [specRow]=await db.query<{body:string}>('SELECT body FROM pod_v2_specs WHERE id=? AND store_id=?',[input.spec_id,store]);
 if(!specRow)podFail('pod_spec_missing');const spec=podPrintSpec.parse(JSON.parse(specRow.body));
 if(spec.sku!==input.sku||spec.shop_id!==env.PRINTIFY_SHOP_ID||spec.valid_until<=Date.now())podFail('pod_spec_stale');
 if(input.assets.length!==spec.placements.length||new Set(input.assets.map(a=>a.position)).size!==input.assets.length)podFail('pod_placement_mismatch');
 const [mapping]=await db.query<{version:string}>('SELECT version FROM pod_mappings WHERE sku=?',[input.sku]);if(!mapping)podFail('pod_mapping_missing');
 const id=crypto.randomUUID(),assets:PodSealedAsset[]=[];
 for(const placement of spec.placements){
  const source=input.assets.find(a=>a.position===placement.position);if(!source)podFail('pod_placement_missing');
  const [art]=await db.query<{object_key:string;sha256:string;approved_at:number|null}>('SELECT object_key,sha256,approved_at FROM pod_artworks WHERE id=? AND cart_id=?',[source.artwork_id,input.cart_id]);
  if(!art?.approved_at)podFail('pod_artwork_unapproved');const object=await env.IMAGES.get(art.object_key);if(!object)podFail('pod_artwork_missing');
  const bytes=await podReadBytes(object.body,20_000_000);if(await podSha(bytes)!==art.sha256)podFail('pod_artwork_checksum_changed');
  await validatePodPrintBytes(bytes,placement.width_px,placement.height_px,placement.safe_inset_px);
  const key=`pod-snapshots/${store}/${id}/${placement.position}-${art.sha256}.png`;
  const created=await env.IMAGES.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'image/png'},sha256:art.sha256});
  if(!created)podFail('pod_snapshot_write_conflict');
  assets.push({position:placement.position,artwork_id:source.artwork_id,object_key:key,sha256:art.sha256,width:placement.width_px,height:placement.height_px,size:bytes.length});
 }
 const metadata={id,store_id:store,cart_id:input.cart_id,sku:input.sku,spec_id:input.spec_id,spec,mapping_version:mapping.version,design_id:input.design_id,design_version:input.design_version,renderer_version:input.renderer_version,assets,sealed_at:Date.now()};
 const snapshot:PodDesignSnapshot={...metadata,hash:await podSha(canonicalPod(metadata))};
 // Never return sealed before object writes and the final transaction succeed. Orphan objects are harmless,
 // private and not provider-accessible; retain for audited cleanup rather than deleting a committed snapshot.
 await db.podV2({action:'seal',store,snapshot});return {id,hash:snapshot.hash,status:'sealed',assets:assets.map(({position,sha256,width,height})=>({position,sha256,width,height}))};
}
export async function podSnapshotAssetUrl(env:Env,base:string,snapshot:PodDesignSnapshot,position:string){
 if(!env.ORDER_TOKEN_SECRET||env.ORDER_TOKEN_SECRET.length<32)podFail('pod_asset_signing_missing');
 const publicBase=new URL(base);if(publicBase.protocol!=='https:'||publicBase.username||publicBase.password||publicBase.search||publicBase.hash)podFail('pod_asset_url_invalid');
 const asset=snapshot.assets.find(a=>a.position===position);if(!asset)podFail('pod_asset_missing');
 const token=await new SignJWT({purpose:'pod-v2-asset',store_id:snapshot.store_id,snapshot_id:snapshot.id,position,sha256:asset.sha256})
  .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('24h').sign(new TextEncoder().encode(env.ORDER_TOKEN_SECRET));
 return `${base.replace(/\/$/,'')}/v1/pod/v2/assets/${snapshot.id}/${position}?token=${encodeURIComponent(token)}`;
}
export async function readPodSnapshotAsset(db:DOStub,env:Env,id:string,position:string,token:string){
 if(!env.IMAGES||!env.ORDER_TOKEN_SECRET||env.ORDER_TOKEN_SECRET.length<32)podFail('pod_asset_unavailable');
 const {payload}=await jwtVerify(token,new TextEncoder().encode(env.ORDER_TOKEN_SECRET),{algorithms:['HS256']});
 const store=env.STORE_ID||'default';if(payload.purpose!=='pod-v2-asset'||payload.store_id!==store||payload.snapshot_id!==id||payload.position!==position)podFail('pod_asset_scope');
 const s=await loadPodDesign(db,store,id),asset=s.assets.find(a=>a.position===position);if(!asset||payload.sha256!==asset.sha256)podFail('pod_asset_scope');
 const object=await env.IMAGES.get(asset.object_key);if(!object)podFail('pod_asset_unavailable');const bytes=await podReadBytes(object.body,20_000_000);
 if(bytes.length!==asset.size||await podSha(bytes)!==asset.sha256)podFail('pod_artwork_checksum_changed');return bytes;
}
