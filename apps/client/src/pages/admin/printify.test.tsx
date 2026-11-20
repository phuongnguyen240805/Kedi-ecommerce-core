import React,{act} from 'react';
import {createRoot,Root} from 'react-dom/client';
const mockGet=jest.fn(),mockPost=jest.fn();
jest.mock('@/authentication',()=>({useSecuredApi:()=>({getJson:mockGet,postJson:mockPost})}));
jest.mock('@/lib/api-base',()=>({getApiBase:()=>''}));
jest.mock('@/layouts/default',()=>({__esModule:true,default:({children}:{children:React.ReactNode})=><div>{children}</div>}));
import PrintifyPage from './printify';
const product={id:'shirt',title:'Test Shirt',blueprint_id:12,print_provider_id:2,variants:[{id:101,title:'Black / S',cost:1000,is_enabled:true},{id:102,title:'Red / S',cost:1100,is_enabled:false}],print_areas:[{variant_ids:[101],placeholders:[{position:'front'}]}]};
let element:HTMLDivElement,root:Root;
beforeEach(()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  mockGet.mockReset();mockPost.mockReset();
  mockGet.mockImplementation((url:string)=>Promise.resolve(url.endsWith('/connection')?{connected:true,shop:{id:29834299,title:'Kedimuse',sales_channel:'custom_integration'},mode:'read_only'}:{items:[product],page:1,next_page:null}));
  element=document.createElement('div');root=createRoot(element);
});
afterEach(async()=>{await act(async()=>root.unmount());});
async function render(){await act(async()=>root.render(<PrintifyPage/>));}
async function click(text:string){const button=Array.from(element.querySelectorAll('button')).find(b=>b.textContent===text);expect(button).toBeTruthy();await act(async()=>button!.click());}
async function input(label:string,value:string){
  const l=Array.from(element.querySelectorAll('label')).find(l=>l.textContent?.startsWith(label));
  const control=l?.querySelector('input,select') as HTMLInputElement|HTMLSelectElement;expect(control).toBeTruthy();
  const setter=Object.getOwnPropertyDescriptor(control instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value')!.set!;
  await act(async()=>{setter.call(control,value);control.dispatchEvent(new Event(control instanceof HTMLSelectElement?'change':'input',{bubbles:true}));});
}
test('loads only read endpoints and renders correct shop and product with private fields absent',async()=>{
  await render();expect(element.textContent).toContain('Kedimuse · 29834299');expect(element.textContent).toContain('Test Shirt');
  expect(mockGet).toHaveBeenCalledWith('/v1/pod/admin/printify/connection');expect(mockGet).toHaveBeenCalledWith('/v1/pod/admin/printify/products?page=1&limit=20');
  expect(mockPost).not.toHaveBeenCalled();expect(element.textContent).toContain('Chế độ chỉ đọc');
  expect(element.querySelector('input[type=password]')).toBeNull();
});
test('empty catalog explains how to proceed without creating a provider product',async()=>{
  mockGet.mockImplementation((url:string)=>Promise.resolve(url.endsWith('/connection')?{connected:true,shop:{id:1,title:'Store',sales_channel:'custom_integration'}}:{items:[],page:1,next_page:null}));
  await render();expect(element.textContent).toContain('Shop chưa có sản phẩm');expect(mockPost).not.toHaveBeenCalled();
});
test('connection error clears catalog and produces actionable error without leaking token',async()=>{
  mockGet.mockRejectedValue(Error('secret-upstream'));await render();expect(element.querySelector('[role=alert]')?.textContent).toContain('Kiểm tra quyền Admin');expect(element.textContent).not.toContain('secret-upstream');expect(element.textContent).not.toContain('Test Shirt');
});
test('numeric pagination requests next page and resets product selection',async()=>{
  mockGet.mockImplementation((url:string)=>Promise.resolve(url.endsWith('/connection')?{connected:true,shop:{id:1,title:'Store',sales_channel:'custom_integration'}}:{items:[product],page:url.includes('page=2')?2:1,next_page:url.includes('page=2')?null:2}));
  await render();await click('Chọn Test Shirt');expect(element.textContent).toContain('Kiểm tra liên kết:');await click('Trang tiếp');
  expect(mockGet).toHaveBeenCalledWith('/v1/pod/admin/printify/products?page=2&limit=20');expect(element.textContent).not.toContain('Kiểm tra liên kết:');
});
test('mapping requires reviewed inputs and checks without saving or enabling production',async()=>{
  mockPost.mockResolvedValue({valid:true,reasons:[],production_cost_minor:1000});await render();await click('Chọn Test Shirt');
  const check=()=>Array.from(element.querySelectorAll('button')).find(b=>b.textContent==='Kiểm tra mapping')!;
  expect(check().disabled).toBe(true);
  await input('SKU Fufuni','POD-S');await input('Biến thể','101');await input('Thuế đã xác nhận','0');await input('Tham chiếu chính sách thuế','reviewed-policy');await input('Hạn xác minh chi phí','2099-01-01T12:00');
  expect(check().disabled).toBe(true);
  await act(async()=>element.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());expect(check().disabled).toBe(false);
  await click('Kiểm tra mapping');expect(mockPost).toHaveBeenCalledTimes(1);expect(mockPost).toHaveBeenCalledWith('/v1/pod/admin/printify/mapping-check',expect.objectContaining({product_id:'shirt',variant_id:101,enabled:false,currency:'USD',tax_bps:0}));
  expect(element.textContent).toContain('Dữ liệu nhà in khớp');expect(element.textContent).toContain('Chưa lưu mapping');
  await input('Vị trí in','back');expect(check().disabled).toBe(true);expect(element.textContent).not.toContain('Dữ liệu nhà in khớp');
});
test('mapping drift is shown and cannot be confused with successful activation',async()=>{
  mockPost.mockResolvedValue({valid:false,reasons:['production_cost_changed'],production_cost_minor:1200});await render();await click('Chọn Test Shirt');
  await input('SKU Fufuni','POD-S');await input('Biến thể','101');await input('Thuế đã xác nhận','0');await input('Tham chiếu chính sách thuế','reviewed-policy');await input('Hạn xác minh chi phí','2099-01-01T12:00');await act(async()=>element.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await click('Kiểm tra mapping');
  expect(element.textContent).toContain('Chi phí sản xuất đã thay đổi');
});
