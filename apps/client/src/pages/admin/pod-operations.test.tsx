import React,{act} from 'react';import {createRoot,Root} from 'react-dom/client';
const mockGet=jest.fn(),mockPost=jest.fn(),mockToken=jest.fn();
jest.mock('@/authentication',()=>({useSecuredApi:()=>({getJson:mockGet,postJson:mockPost}),useAuth:()=>({getAccessToken:mockToken})}));
jest.mock('@/lib/api-base',()=>({getApiBase:()=>''}));
jest.mock('@/layouts/default',()=>({__esModule:true,default:({children}:{children:React.ReactNode})=><div>{children}</div>}));
import PodOperations from './pod-operations';
let root:Root,element:HTMLDivElement;
const ready={storage_configured:false,provider_configured:true,signing_configured:true,stripe_configured:true,pod_enabled:false,submit_enabled:false,account_verified:false,active_mappings:0};
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;mockGet.mockReset();mockPost.mockReset();mockToken.mockResolvedValue('private-staff-token');element=document.createElement('div');root=createRoot(element);mockGet.mockResolvedValue(ready);});
afterEach(async()=>{await act(async()=>root.unmount());});
test('disabled POD renders missing R2 readiness without fetching artwork or submitting operations',async()=>{
 await act(async()=>root.render(<PodOperations/>));expect(element.textContent).toContain('POD đang tắt');expect(mockGet).toHaveBeenCalledTimes(1);expect(mockPost).not.toHaveBeenCalled();expect(mockToken).not.toHaveBeenCalled();
});
test('enabled operations show locked review state and unknown submission cannot be resubmitted',async()=>{
 mockGet.mockImplementation((url:string)=>Promise.resolve(url.includes('readiness')?{...ready,pod_enabled:true}:url.includes('artworks')?{items:[{id:'art',cart_id:'cart',width:100,height:100,approved_at:null,cart_status:'checked_out'}]}:{items:[{id:'job',order_id:'order',state:'submission_unknown',external_id:null,status_json:null}]}));
 await act(async()=>root.render(<PodOperations/>));const buttons=Array.from(element.querySelectorAll('button'));expect(buttons.find(b=>b.textContent==='Xem file art')?.disabled).toBe(true);expect(buttons.find(b=>b.textContent==='Cập nhật trạng thái job')?.disabled).toBe(true);expect(mockPost).not.toHaveBeenCalled();
});
test('operation errors display a sanitized message',async()=>{mockGet.mockRejectedValue(Error('secret'));await act(async()=>root.render(<PodOperations/>));expect(element.textContent).toContain('Không tải được vận hành POD');expect(element.textContent).not.toContain('secret');});

test('staged production approval requires explicit evidence and confirmation and does not send production',async()=>{
 mockGet.mockImplementation((url:string)=>Promise.resolve(url.includes('readiness')?{...ready,pod_enabled:true,staged_enabled:true}:url.includes('/health')?{readiness:{storage_ready:false}}:{items:[]}));
 await act(async()=>root.render(<PodOperations/>));
 const button=()=>Array.from(element.querySelectorAll('button')).find(b=>b.textContent==='Ghi duyệt sản xuất cho đơn')!;
 expect(button().disabled).toBe(true);
 const fill=async(input:HTMLInputElement|HTMLTextAreaElement,value:string)=>{await act(async()=>{const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});};
 await fill(element.querySelector('textarea')!,'Reviewed exact snapshot, payment, provider IDs and print costs.');
 const jobLabel=Array.from(element.querySelectorAll('label')).find(l=>l.textContent?.startsWith('Fulfillment ID'))!;await fill(jobLabel.querySelector('input')!,'fixture-job');expect(button().disabled).toBe(true);
 const confirmation=Array.from(element.querySelectorAll('label')).find(l=>l.textContent?.includes('đồng ý cho đơn này sản xuất'))!;
 await act(async()=>confirmation.querySelector<HTMLInputElement>('input')!.click());expect(button().disabled).toBe(false);
 await act(async()=>button().click());expect(mockPost).toHaveBeenCalledTimes(1);expect(mockPost).toHaveBeenCalledWith('/v1/pod/v2/admin/fulfillments/fixture-job/approve-production',expect.objectContaining({evidence:'Reviewed exact snapshot, payment, provider IDs and print costs.'}));
 expect(mockPost.mock.calls.some(([url])=>String(url).includes('send_to_production'))).toBe(false);
});
test('approval requires actual preview, review confirmation and evidence before sending',async()=>{
 mockGet.mockImplementation((url:string)=>Promise.resolve(url.includes('readiness')?{...ready,pod_enabled:true}:url.includes('artworks')?{items:[{id:'art',cart_id:'cart',width:100,height:100,approved_at:null,cart_status:'open'}]}:{items:[]}));
 const oldFetch=globalThis.fetch;const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
 let read=false;globalThis.fetch=jest.fn(async()=>({ok:true,headers:{get:()=> 'image/png'},body:{getReader:()=>({read:async()=>{if(read)return {done:true};read=true;return {done:false,value:new Uint8Array([1,2,3])};}})}})) as unknown as typeof fetch;
 URL.createObjectURL=jest.fn(()=> 'blob:preview');URL.revokeObjectURL=jest.fn();
 const click=async(text:string)=>{const b=Array.from(element.querySelectorAll('button')).find(b=>b.textContent===text)!;await act(async()=>b.click());};
 try{
  await act(async()=>root.render(<PodOperations/>));await click('Xem file art');expect(element.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
  const approve=()=>Array.from(element.querySelectorAll('button')).find(b=>b.textContent==='Duyệt artwork')!;expect(approve().disabled).toBe(true);
  await act(async()=>{const t=element.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(t,'Reviewed actual file, print area and usage rights.');t.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(approve().disabled).toBe(true);await act(async()=>element.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());expect(approve().disabled).toBe(false);
  await click('Duyệt artwork');expect(mockPost).toHaveBeenCalledWith('/v1/pod/artworks/art/approve',{evidence:'Reviewed actual file, print area and usage rights.'});expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
 }finally{globalThis.fetch=oldFetch;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;}
});
