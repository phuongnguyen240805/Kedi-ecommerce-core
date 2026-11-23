import {useEffect,useState} from 'react';
import {useSecuredApi} from '@/authentication';
type Operation={id:string;fulfillment_id:string;operation:string;state:string;resource_id:string|null;error_code:string|null};
const button='rounded border px-3 py-2 disabled:opacity-40';
export function PodV2Panel({base}:{base:string}){
 const {getJson,postJson}=useSecuredApi();const [ops,setOps]=useState<Operation[]>([]),[health,setHealth]=useState<unknown>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [spec,setSpec]=useState(''),[mapping,setMapping]=useState(''),[specId,setSpecId]=useState(''),[evidence,setEvidence]=useState(''),[shopVerified,setShopVerified]=useState(false),[job,setJob]=useState(''),[approve,setApprove]=useState(false);
 const [operationId,setOperationId]=useState(''),[providerId,setProviderId]=useState('');
 async function load(){const [o,h]=await Promise.all([getJson(base+'/v2/admin/operations'),getJson(base+'/v2/admin/health')]);setOps(o.items);setHealth(h);}
 useEffect(()=>{void load().catch(()=>setMessage('Không tải được trạng thái POD mới.'));},[base]);
 async function run(work:()=>Promise<void>){setBusy(true);setMessage('');try{await work();await load();}catch{setMessage('Thao tác chưa được xác nhận. Kiểm tra cấu hình và đối soát; không gửi lại POST nhà in.');}finally{setBusy(false);}}
 const valid=evidence.trim().length>=10;
 return <section className="space-y-4 rounded border p-4"><h2 className="text-xl font-semibold">Pipeline POD mới</h2>{message&&<p role="status">{message}</p>}
  <p>Stripe test không cấp quyền in thật. R2 và Manual Approval phải sẵn sàng; xác nhận bên dưới được lưu audit, không thay cấu hình Printify.</p>
  <label className="block">Bằng chứng / lý do<textarea className="block w-full border p-2" value={evidence} onChange={e=>setEvidence(e.target.value)} /></label>
  <details><summary>Print spec và mapping</summary><label className="block">Print spec JSON<textarea aria-label="Print spec JSON" className="block h-40 w-full border p-2" value={spec} onChange={e=>setSpec(e.target.value)}/></label>
   <button className={button} disabled={busy||!spec} onClick={()=>void run(async()=>{const result=await postJson(base+'/v2/admin/specs/check',JSON.parse(spec));setSpec(JSON.stringify({...JSON.parse(spec),catalog_hash:result.catalog_hash},null,2));setMessage('Đã kiểm tra catalog. Tiếp tục đối chiếu kích thước vật lý trước khi duyệt.');})}>Kiểm tra catalog</button>
   <button className={button} disabled={busy||!spec||!valid} onClick={()=>void run(async()=>{const result=await postJson(base+'/v2/admin/specs',{spec:JSON.parse(spec),evidence});setSpecId(result.id);setMessage('Đã lưu phiên bản print spec.');})}>Duyệt print spec</button>
   <label>Spec ID<input className="block w-full border p-2" value={specId} onChange={e=>setSpecId(e.target.value)}/></label><label>Mapping JSON<textarea aria-label="Mapping JSON" className="block h-32 w-full border p-2" value={mapping} onChange={e=>setMapping(e.target.value)}/></label>
   <button className={button} disabled={busy||!specId||!mapping||!valid} onClick={()=>void run(async()=>{await postJson(base+'/v2/admin/mappings/activate',{spec_id:specId,mapping:JSON.parse(mapping),evidence});setMessage('Đã kích hoạt mapping qua print spec đã duyệt.');})}>Kích hoạt mapping đã kiểm tra</button>
  </details>
  <label className="flex gap-2"><input type="checkbox" checked={shopVerified} onChange={e=>setShopVerified(e.target.checked)}/>Tôi đã kiểm tra shop Printify đang ở Manual Approval.</label>
  <button className={button} disabled={busy||!valid||!shopVerified} onClick={()=>void run(async()=>{await postJson(base+'/v2/admin/shop/manual-approval',{evidence,valid_until:Date.now()+3600000});setShopVerified(false);setMessage('Đã ghi nhận bằng chứng Manual Approval, hiệu lực 1 giờ.');})}>Ghi nhận kiểm tra shop</button>
  <label className="block">Fulfillment ID<input className="block w-full border p-2" value={job} onChange={e=>{setJob(e.target.value);setApprove(false);}}/></label>
  <button className={button} disabled={busy||!job} onClick={()=>void run(async()=>{await postJson(base+'/v2/admin/fulfillments/'+encodeURIComponent(job)+'/reconcile',{});setMessage('Đã chạy kiểm tra theo các cờ hiện hành.');})}>Chạy pipeline theo các cờ hiện hành</button>
  <label className="flex gap-2"><input type="checkbox" checked={approve} onChange={e=>setApprove(e.target.checked)}/>Tôi đã xem file in, đúng product, thanh toán và chi phí; đồng ý cho đơn này sản xuất.</label>
  <button className={button} disabled={busy||!valid||!job||!approve} onClick={()=>void run(async()=>{await postJson(base+'/v2/admin/fulfillments/'+encodeURIComponent(job)+'/approve-production',{evidence,valid_until:Date.now()+3600000});setApprove(false);setMessage('Đã ghi duyệt cho đúng phiên bản đơn. Runner chỉ gửi khi mọi cổng kiểm tra và cờ release cho phép.');})}>Ghi duyệt sản xuất cho đơn</button>
  <h3>Thao tác nhà in</h3>{ops.map(o=><article className="border p-3" key={o.id}><p>{o.fulfillment_id} · {o.operation} · {o.state}</p><p>{o.resource_id||'Chưa có mã xác nhận'} · {o.error_code||''}</p>{o.state==='outcome_unknown'&&<p>Cần đối soát provider GET trước khi tiếp tục. Không tự tạo lại tài nguyên.</p>}</article>)}
  <details><summary>Đối soát thao tác chưa rõ kết quả</summary><label>Operation ID<input className="block w-full border p-2" value={operationId} onChange={e=>setOperationId(e.target.value)}/></label><label>Mã tài nguyên trong Printify<input className="block w-full border p-2" value={providerId} onChange={e=>setProviderId(e.target.value)}/></label><button className={button} disabled={busy||!valid||!operationId||!providerId} onClick={()=>void run(async()=>{await postJson(base+'/v2/admin/operations/'+encodeURIComponent(operationId)+'/reconcile',{resource_id:providerId,evidence});setMessage('Đã đối soát bằng provider GET; không tạo lại tài nguyên.');})}>Kiểm tra và gắn tài nguyên đã có</button></details>
  <details><summary>Readiness và hàng đợi webhook</summary><pre className="overflow-auto text-sm">{JSON.stringify(health,null,2)}</pre></details>
 </section>;
}
