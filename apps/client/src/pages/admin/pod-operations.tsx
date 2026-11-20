import {useEffect,useRef,useState} from 'react';
import DefaultLayout from '@/layouts/default';
import {useAuth,useSecuredApi} from '@/authentication';
import {getApiBase} from '@/lib/api-base';
type Readiness={storage_configured:boolean;provider_configured:boolean;signing_configured:boolean;stripe_configured:boolean;pod_enabled:boolean;submit_enabled:boolean;account_verified:boolean;active_mappings:number};
type Artwork={id:string;cart_id:string;width:number;height:number;approved_at:number|null;cart_status:string};
type Job={id:string;order_id:string;state:string;external_id:string|null;status_json:string|null};
const button='rounded-lg border px-4 py-2 disabled:opacity-40';
export default function PodOperations(){
 const {getJson,postJson}=useSecuredApi();const {getAccessToken}=useAuth();const base=getApiBase()+'/v1/pod';
 const [ready,setReady]=useState<Readiness|null>(null),[artworks,setArtworks]=useState<Artwork[]>([]),[jobs,setJobs]=useState<Job[]>([]);
 const [selected,setSelected]=useState<Artwork|null>(null),[preview,setPreview]=useState(''),[evidence,setEvidence]=useState(''),[reviewed,setReviewed]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');const generation=useRef(0),previewUrl=useRef('');
 function clearPreview(){if(previewUrl.current)URL.revokeObjectURL(previewUrl.current);previewUrl.current='';setPreview('');setReviewed(false);setEvidence('');setSelected(null);}
 async function load(){const id=++generation.current;setBusy(true);setMessage('');clearPreview();try{
  const value:Readiness=await getJson(base+'/admin/printify/readiness');if(id!==generation.current)return;setReady(value);
  if(value.pod_enabled){const [a,j]=await Promise.all([getJson(base+'/admin/artworks'),getJson(base+'/admin/fulfillments')]);if(id===generation.current){setArtworks(a.items);setJobs(j.items);}}
  else{setArtworks([]);setJobs([]);}
 }catch{if(id===generation.current)setMessage('Không tải được vận hành POD. Kiểm tra quyền Admin và backend.');}finally{if(id===generation.current)setBusy(false);}}
 useEffect(()=>{void load();return()=>{generation.current++;if(previewUrl.current)URL.revokeObjectURL(previewUrl.current);};},[base]);
 async function inspect(art:Artwork){const id=++generation.current;setBusy(true);setMessage('');clearPreview();try{
  const token=await getAccessToken();if(!token)throw Error();
  const response=await fetch(base+'/admin/artworks/'+encodeURIComponent(art.id)+'/preview',{headers:{Authorization:'Bearer '+token},redirect:'error',cache:'no-store'});
  if(!response.ok||!response.headers.get('Content-Type')?.startsWith('image/png'))throw Error();
  const reader=response.body?.getReader();if(!reader)throw Error();const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20_000_000){await reader.cancel();throw Error();}chunks.push(new Uint8Array(value));}
  if(id!==generation.current)return;const url=URL.createObjectURL(new Blob(chunks,{type:'image/png'}));previewUrl.current=url;setPreview(url);setSelected(art);
 }catch{if(id===generation.current)setMessage('Không mở được file in. Kiểm tra storage và quyền truy cập.');}finally{if(id===generation.current)setBusy(false);}}
 async function review(approve:boolean){if(!selected||busy||evidence.trim().length<10||(approve&&!reviewed))return;setBusy(true);setMessage('');try{
  await postJson(base+'/artworks/'+selected.id+(approve?'/approve':'/reject'),{evidence:evidence.trim()});await load();setMessage(approve?'Đã duyệt file in.':'Đã từ chối file; khách cần tải lại hoặc liên hệ shop.');
 }catch{setMessage('Không lưu được đánh giá. File có thể đã bị khóa khi bắt đầu thanh toán.');}finally{setBusy(false);}}
 async function reconcile(job:Job){if(!job.external_id)return;setBusy(true);setMessage('');try{await postJson(base+'/admin/fulfillments/'+job.id+'/reconcile',{});await load();}catch{setMessage('Chưa đối soát được. Không tự gửi lại đơn sản xuất.');}finally{setBusy(false);}}
 return <DefaultLayout><main className="mx-auto max-w-6xl space-y-5 p-5"><h1 className="text-3xl font-semibold">Vận hành POD</h1><a href="./printify" className="underline">Catalog và mapping Printify</a><button className={button} disabled={busy} onClick={()=>void load()}>Làm mới vận hành</button>{message&&<p role="status">{message}</p>}
 {ready&&<section><h2 className="text-xl font-semibold">Điều kiện kích hoạt</h2><dl>{Object.entries({Storage:ready.storage_configured,Printify:ready.provider_configured,'Ký URL artwork':ready.signing_configured,Stripe:ready.stripe_configured,'Luồng POD':ready.pod_enabled,'Gửi in':ready.submit_enabled,'Tài khoản sản xuất đã xác minh':ready.account_verified}).map(([label,value])=><div className="flex gap-4 border-b p-2" key={label}><dt>{label}</dt><dd>{value?'Đã có / bật':'Chưa có / tắt'}</dd></div>)}</dl><p>{ready.active_mappings} mapping đang bật</p>{!ready.pod_enabled&&<p>POD đang tắt. Chưa tải danh sách artwork hoặc thực hiện thao tác sản xuất. Cấu hình R2 và nghiệm thu staging trước khi bật.</p>}</section>}
 {ready?.pod_enabled&&<><section className="space-y-3"><h2 className="text-xl font-semibold">Duyệt file in</h2>{!artworks.length&&<p>Chưa có artwork.</p>}<div className="grid gap-3 sm:grid-cols-2">{artworks.map(art=><article className="rounded-lg border p-3" key={art.id}><p>{art.id}</p><p>{art.width} × {art.height} px · {art.approved_at?'Đã duyệt':'Chưa duyệt'} · {art.cart_status}</p><button className={button} disabled={busy||art.cart_status!=='open'} onClick={()=>void inspect(art)}>Xem file {art.id}</button></article>)}</div>
 {selected&&preview&&<div className="space-y-3 rounded-lg border p-4"><img src={preview} alt="File in cần duyệt" className="max-h-96 max-w-full object-contain"/><label className="block">Bằng chứng đánh giá<textarea className="block w-full rounded border p-3" maxLength={800} value={evidence} disabled={busy} onChange={e=>setEvidence(e.target.value)}/></label><label className="block"><input type="checkbox" checked={reviewed} disabled={busy} onChange={e=>setReviewed(e.target.checked)}/> Tôi đã xem file thực tế, kiểm tra chất lượng, vị trí in và quyền sử dụng.</label><button className={button} disabled={busy||!reviewed||evidence.trim().length<10} onClick={()=>void review(true)}>Duyệt artwork</button><button className={button} disabled={busy||evidence.trim().length<10} onClick={()=>void review(false)}>Từ chối artwork</button></div>}</section>
 <section className="space-y-3"><h2 className="text-xl font-semibold">Đơn sản xuất và ngoại lệ</h2><p>Đối soát đơn đã có mã Printify chỉ cập nhật trạng thái. Không tạo lại đơn khi kết quả gửi chưa rõ; hủy/hoàn tiền cần xử lý riêng với nhà in và bộ phận thanh toán.</p>{!jobs.length&&<p>Chưa có fulfillment.</p>}{jobs.map(job=><article className="space-y-2 rounded-lg border p-3" key={job.id}><p>Đơn {job.order_id}</p><p>{job.state} · {job.external_id||'Chưa có mã nhà in'}</p>{job.status_json&&<pre className="overflow-x-auto text-sm">{job.status_json}</pre>}<button className={button} disabled={busy||!job.external_id} onClick={()=>void reconcile(job)}>Cập nhật trạng thái {job.id}</button></article>)}</section></>}
 </main></DefaultLayout>;
}
