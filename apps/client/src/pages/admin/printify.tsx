import {useEffect,useRef,useState} from 'react';
import DefaultLayout from '@/layouts/default';
import {useSecuredApi} from '@/authentication';
import {getApiBase} from '@/lib/api-base';

type Product={id:string;title:string;blueprint_id:number;print_provider_id:number;
  variants:{id:number;title:string;cost:number;is_enabled:boolean}[];
  print_areas:{variant_ids:number[];placeholders:{position:string}[]}[]};
type Connection={connected:boolean;shop:{id:number;title:string;sales_channel:string};mode:string};
type Catalog={items:Product[];page:number;next_page:number|null};
type MappingCheck={valid:boolean;reasons:string[];production_cost_minor:number|null};
const field='block w-full rounded-lg border p-3';
const button='rounded-lg border px-4 py-2 disabled:opacity-40';
const labels:Record<string,string>={blueprint_mismatch:'Mẫu sản phẩm đã thay đổi',print_provider_mismatch:'Nhà in đã thay đổi',variant_missing:'Không tìm thấy biến thể',variant_disabled:'Biến thể đã tắt',production_cost_changed:'Chi phí sản xuất đã thay đổi',placement_unavailable:'Vị trí in không hỗ trợ biến thể này',cost_verification_expired:'Xác minh chi phí đã hết hạn'};

export default function PrintifyPage(){
  const {getJson,postJson}=useSecuredApi();
  const base=getApiBase()+'/v1/pod/admin/printify';
  const [connection,setConnection]=useState<Connection|null>(null),[catalog,setCatalog]=useState<Catalog|null>(null);
  const [selected,setSelected]=useState<Product|null>(null),[variantId,setVariantId]=useState(''),[placement,setPlacement]=useState('front');
  const [sku,setSku]=useState(''),[countries,setCountries]=useState('US'),[minimumMargin,setMinimumMargin]=useState('500');
  const [tax,setTax]=useState(''),[policy,setPolicy]=useState(''),[until,setUntil]=useState('');
  const [minWidth,setMinWidth]=useState('1000'),[minHeight,setMinHeight]=useState('1000');
  const [currencyConfirmed,setCurrencyConfirmed]=useState(false),[result,setResult]=useState<MappingCheck|null>(null);
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0);
  const variant=selected?.variants.find(v=>String(v.id)===variantId);
  const destinations=countries.split(',').map(c=>c.trim().toUpperCase()).filter(Boolean);
  const valid=!!selected&&!!variant&&variant.is_enabled&&!!sku.trim()&&sku.trim().length<=150&&
    selected.print_areas.some(a=>a.variant_ids.includes(variant.id)&&a.placeholders.some(p=>p.position===placement))&&
    destinations.length>0&&destinations.every(c=>/^[A-Z]{2}$/.test(c))&&
    minimumMargin.trim()!==''&&Number.isInteger(Number(minimumMargin))&&Number(minimumMargin)>=0&&Number(minimumMargin)<=100_000_000&&
    tax.trim()!==''&&Number.isInteger(Number(tax))&&Number(tax)>=0&&Number(tax)<=10000&&
    [minWidth,minHeight].every(v=>Number.isInteger(Number(v))&&Number(v)>=100&&Number(v)<=15000)&&policy.trim().length>=3&&policy.trim().length<=200&&Date.parse(until)>Date.now()&&currencyConfirmed;

  async function load(page=1){
    const request=++generation.current;setBusy(true);setMessage('');setResult(null);setSelected(null);setVariantId('');setConnection(null);setCatalog(null);
    try{
      const status:Connection=await getJson(base+'/connection');if(request!==generation.current)return;setConnection(status);
      const products:Catalog=await getJson(base+`/products?page=${page}&limit=20`);if(request===generation.current)setCatalog(products);
    }catch{if(request===generation.current){setCatalog(null);setMessage('Không tải được Printify. Kiểm tra quyền Admin, cấu hình shop và kết nối backend.');}}
    finally{if(request===generation.current)setBusy(false);}
  }
  useEffect(()=>{setConnection(null);setCatalog(null);void load();return()=>{generation.current++;};},[base]);
  function choose(product:Product){setSelected(product);setVariantId('');setPlacement('front');setResult(null);setCurrencyConfirmed(false);setUntil('');}
  function candidate(){
    return {product_id:selected!.id,variant_id:variant!.id,blueprint_id:selected!.blueprint_id,print_provider_id:selected!.print_provider_id,
      placement,min_width:Number(minWidth),min_height:Number(minHeight),countries:destinations,production_cost_minor:variant!.cost,
      cost_verified_until:Date.parse(until),minimum_margin_minor:Number(minimumMargin),tax_bps:Number(tax),tax_policy_ref:policy.trim(),currency:'USD',enabled:false};
  }
  async function check(){
    if(!valid||busy)return;const request=++generation.current;setBusy(true);setMessage('');setResult(null);
    try{const value:MappingCheck=await postJson(base+'/mapping-check',candidate());if(request===generation.current)setResult(value);}
    catch{if(request===generation.current)setMessage('Chưa kiểm tra được mapping. Xem lại dữ liệu hoặc thử lại.');}
    finally{if(request===generation.current)setBusy(false);}
  }
  async function saveDraft(){if(!valid||busy)return;setBusy(true);setMessage('');try{await postJson(base+'/mapping-draft',{sku:sku.trim(),currency_confirmed:true,mapping:candidate()});setMessage('Đã lưu mapping nháp; vẫn tắt, chưa đưa sản phẩm vào checkout.');}catch{setMessage('Chưa lưu được. Kiểm tra SKU Fufuni active, giá USD và mapping hiện không bật.');}finally{setBusy(false);}}
  return <DefaultLayout><main className="mx-auto max-w-6xl space-y-6 p-5">
    <header className="space-y-2"><h1 className="text-3xl font-semibold">Printify</h1><p>Xem sản phẩm và chuẩn bị mapping nháp trước khi cấu hình bán POD.</p><p className="rounded-lg border p-3">Chế độ chỉ đọc với Printify. Mapping nháp lưu riêng trong Fufuni và luôn tắt; không gửi đơn sản xuất.</p><a className="underline" href="./pod-operations">Duyệt artwork và vận hành POD</a></header>
    <section className="space-y-3" aria-label="Kết nối Printify">
      <button className={button} disabled={busy} onClick={()=>void load()}>Làm mới kết nối</button>
      {busy&&<p role="status">Đang kiểm tra Printify…</p>}
      {message&&<p role="alert">{message}</p>}
      {connection&&<dl className="grid gap-2 rounded-lg border p-4"><div><dt>Trạng thái</dt><dd>{connection.connected?'Đã kết nối':'Chưa kết nối'}</dd></div><div><dt>Shop</dt><dd>{connection.shop.title} · {connection.shop.id}</dd></div><div><dt>Kênh bán</dt><dd>{connection.shop.sales_channel}</dd></div></dl>}
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Sản phẩm trong shop</h2>
      {catalog&&!catalog.items.length&&<p>Shop chưa có sản phẩm ở trang này. Thêm sản phẩm trong My products của Printify rồi làm mới; chưa cần xuất bản lên website.</p>}
      <div className="grid gap-3 sm:grid-cols-2">{catalog?.items.map(product=><article key={product.id} className="space-y-2 rounded-lg border p-4"><h3 className="font-semibold">{product.title}</h3><p>Mã: {product.id}</p><p>Mẫu {product.blueprint_id} · Nhà in {product.print_provider_id}</p><p>{product.variants.filter(v=>v.is_enabled).length} biến thể đang bật</p><button className={button} disabled={busy} onClick={()=>choose(product)}>Chọn {product.title}</button></article>)}</div>
      {catalog&&<nav className="flex items-center gap-3" aria-label="Trang sản phẩm"><button className={button} disabled={busy||catalog.page<=1} onClick={()=>void load(catalog.page-1)}>Trang trước</button><span>Trang {catalog.page}</span><button className={button} disabled={busy||!catalog.next_page} onClick={()=>void load(catalog.next_page!)}>Trang tiếp</button></nav>}
    </section>
    {selected&&<section className="space-y-4 rounded-lg border p-4"><h2 className="text-xl font-semibold">Kiểm tra liên kết: {selected.title}</h2>
      <p>Chi phí bên dưới là số tiền nhỏ nhất theo tài khoản nhà in. Xác nhận tài khoản được tính phí bằng USD trước khi kiểm tra.</p>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2" onChange={()=>setResult(null)}>
        <label>SKU Fufuni<input className={field} value={sku} maxLength={150} onChange={e=>setSku(e.target.value)}/></label>
        <label>Biến thể<select className={field} value={variantId} onChange={e=>setVariantId(e.target.value)}><option value="">Chọn biến thể</option>{selected.variants.map(v=><option key={v.id} value={v.id} disabled={!v.is_enabled}>{v.title}{v.is_enabled?'':' (đã tắt)'} · {v.cost} đơn vị nhỏ nhất</option>)}</select></label>
        <label>Vị trí in<select className={field} value={placement} onChange={e=>setPlacement(e.target.value)}><option value="front">Mặt trước</option><option value="back">Mặt sau</option></select></label>
        <label>Chiều rộng file tối thiểu (pixel)<input className={field} type="number" min="100" max="15000" value={minWidth} onChange={e=>setMinWidth(e.target.value)}/></label>
        <label>Chiều cao file tối thiểu (pixel)<input className={field} type="number" min="100" max="15000" value={minHeight} onChange={e=>setMinHeight(e.target.value)}/></label>
        <label>Quốc gia dự kiến (mã cách nhau bằng dấu phẩy)<input className={field} value={countries} onChange={e=>setCountries(e.target.value)}/></label>
        <label>Biên tối thiểu (cent USD)<input className={field} type="number" min="0" max="100000000" step="1" value={minimumMargin} onChange={e=>setMinimumMargin(e.target.value)}/></label>
        <label>Thuế đã xác nhận (basis point; 100 = 1%)<input className={field} type="number" min="0" max="10000" step="1" value={tax} onChange={e=>setTax(e.target.value)}/></label>
        <label>Tham chiếu chính sách thuế<input className={field} value={policy} maxLength={200} onChange={e=>setPolicy(e.target.value)}/></label>
        <label>Hạn xác minh chi phí (giờ máy của bạn)<input className={field} type="datetime-local" value={until} onChange={e=>setUntil(e.target.value)}/></label>
        <label className="sm:col-span-2"><input type="checkbox" checked={currencyConfirmed} onChange={e=>setCurrencyConfirmed(e.target.checked)}/> Tôi đã xác nhận tài khoản Printify tính phí bằng USD.</label>
      </fieldset>
      <p>Kiểm tra này đối chiếu dữ liệu nhà in; chưa xác minh SKU Fufuni tồn tại, phí ship, thuế, lợi nhuận hay chất lượng file in.</p>
      <button className={button} disabled={!valid||busy} onClick={()=>void check()}>Kiểm tra mapping</button>
      <button className={button} disabled={!valid||busy} onClick={()=>void saveDraft()}>Lưu mapping nháp (tắt)</button>
      {result&&<div role="status" className="space-y-2 rounded-lg border p-3"><p>{result.valid?'Dữ liệu nhà in khớp tại thời điểm kiểm tra. Chưa lưu mapping.':'Mapping cần kiểm tra lại.'}</p><ul>{result.reasons.map(reason=><li key={reason}>{labels[reason]||reason}</li>)}</ul></div>}
    </section>}
  </main></DefaultLayout>;
}
