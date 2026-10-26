export const setupHtml = `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Kết nối nguồn catalog Pancake</title><style>
body{font:16px system-ui;max-width:760px;margin:48px auto;padding:0 20px;color:#17233a}input{width:100%;box-sizing:border-box;padding:12px}button{padding:10px 16px;margin:12px 8px 0 0;cursor:pointer}pre{white-space:pre-wrap;background:#f1f5f9;padding:18px}small{color:#526070}
</style><h1>Catalog Pancake qua ctxlayer</h1><p>Kết nối tài khoản tích hợp một lần. Job Fufuni đồng bộ và lưu database; Halifruit đọc API Fufuni.</p>
<label>JWT nhân viên Fufuni có quyền admin store<input id="token" type="password" autocomplete="off"></label>
<small>Token chỉ giữ trong bộ nhớ trang. Sau OAuth, nhập lại JWT để hoàn tất. Không dùng token Pancake ở đây.</small><div>
<button id="status">Trạng thái</button><button id="connect">Kết nối ctxlayer</button><button id="complete">Hoàn tất OAuth</button>
<button id="trial">Đồng bộ thử 1 sản phẩm</button><button id="sync">Đồng bộ toàn bộ</button><button id="disconnect">Ngắt kết nối</button></div>
<pre id="output" aria-live="polite">Chưa tải trạng thái.</pre><script>
const query=new URLSearchParams(location.search),pending={code:query.get('code'),state:query.get('state')};
history.replaceState(null,'',location.pathname);const output=document.getElementById('output');
const base=location.pathname.replace(/\\/(setup|callback)$/,'');const prefix=base.replace(/\\/v1\\/integrations\\/ctxlayer$/,'');
if(query.has('error'))output.textContent='OAuth đã bị từ chối. Bấm Kết nối để bắt đầu lại.';
async function call(path,method='GET',body){const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{Authorization:'Bearer '+document.getElementById('token').value,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();output.textContent=JSON.stringify(data,null,2);if(!response.ok)throw Error('request_failed');return data;}
async function action(fn){const buttons=document.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);try{await fn();}catch(error){if(error.message!=='request_failed')output.textContent='Không kết nối được backend hoặc phản hồi không hợp lệ.';}finally{buttons.forEach(b=>b.disabled=false);}}
document.getElementById('status').onclick=()=>action(()=>call(prefix+'/v1/integrations/pancake/status'));
document.getElementById('connect').onclick=()=>action(async()=>{const result=await call(base+'/connect','POST',{});location.assign(result.authorization_url);});
document.getElementById('complete').onclick=()=>action(async()=>{if(!pending.code||!pending.state){output.textContent='Chưa có callback OAuth hợp lệ.';return;}await call(base+'/complete','POST',pending);pending.code=null;pending.state=null;});
document.getElementById('trial').onclick=()=>action(()=>call(prefix+'/v1/integrations/pancake/sync','POST',{limit_products:1}));
document.getElementById('sync').onclick=()=>action(()=>call(prefix+'/v1/integrations/pancake/sync','POST',{}));
document.getElementById('disconnect').onclick=()=>action(()=>call(base+'/connection','DELETE'));
</script></html>`
