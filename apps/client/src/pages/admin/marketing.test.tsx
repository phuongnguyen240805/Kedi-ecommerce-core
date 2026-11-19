import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
const mockApi={getJson:jest.fn(),postJson:jest.fn()};
jest.mock('@/authentication',()=>({useSecuredApi:()=>mockApi}));
jest.mock('@/lib/api-base',()=>({getApiBase:()=>''}));
jest.mock('@/layouts/default',()=>({__esModule:true,default:({children}:{children:React.ReactNode})=><div>{children}</div>}));
import MarketingPage from './marketing';
let element:HTMLDivElement,root:Root;
beforeEach(async()=>{jest.clearAllMocks();(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 mockApi.getJson.mockImplementation(async(url:string)=>url.includes('/overview')?{subscribers:[{status:'active',count:3}],jobs:[],attributed_revenue:[{currency:'USD',net_revenue_minor:2500,orders:1}]}:url.includes('/rfm')?{rows:[{id:'buyer',email:'buyer@test.com',currency:'USD',recency_days:3,frequency:1,monetary_minor:2500,segment:'recent'}],next_cursor:null,window_days:365}:{rows:[]});
 mockApi.postJson.mockResolvedValue({draft:{subject:'Draft subject',text:'Draft text for review only.'}});element=document.createElement('div');document.body.append(element);root=createRoot(element);await act(async()=>root.render(<MarketingPage/>));
});
afterEach(async()=>{await act(async()=>root.unmount());element.remove();});
const button=(text:string)=>Array.from(element.querySelectorAll('button')).find(b=>b.textContent===text)!;
test('dashboard only reads on load, and experiment publication requires reviewed content in both variants',()=>{expect(mockApi.postJson).not.toHaveBeenCalled();expect(element.textContent).toContain('buyer@test.com');expect(element.textContent).toContain('USD');expect(button('Lưu và bắt đầu thử nghiệm').disabled).toBe(true);});
test('AI drafting fills variant B and never starts an experiment or sends email',async()=>{
 const brief=element.querySelector('textarea')!;await act(async()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(brief),'value')!.set!.call(brief,'A welcome email for our new custom print shop.');brief.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>button('Gợi ý bản nháp B bằng AI').click());expect(mockApi.postJson).toHaveBeenCalledTimes(1);expect(mockApi.postJson).toHaveBeenCalledWith('/v1/marketing/admin/draft',expect.objectContaining({kind:'welcome'}));expect((element.querySelectorAll('input')[1] as HTMLInputElement).value).toBe('Draft subject');expect(button('Lưu và bắt đầu thử nghiệm').disabled).toBe(true);expect(element.textContent).toContain('Chưa gửi email.');
});
