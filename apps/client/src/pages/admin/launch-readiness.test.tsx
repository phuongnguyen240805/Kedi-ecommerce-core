import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
const mockGet=jest.fn();
jest.mock('@/authentication',()=>({useSecuredApi:()=>({getJson:mockGet})}));
jest.mock('@/lib/api-base',()=>({getApiBase:()=>''}));
jest.mock('@/layouts/default',()=>({__esModule:true,default:({children}:{children:React.ReactNode})=><div>{children}</div>}));
import LaunchReadiness from './launch-readiness';
test('readiness renders missing merchant configuration and service mode using GET only',async()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;mockGet.mockResolvedValue({items:[{id:'v',sku:'SHIRT',available:0,ready:false,reasons:['shipping_weight_missing','explicit_currency_price_missing'],currencies:[]}],next_cursor:null,integrations:{stripe_mode:'test',marketing_send_enabled:false}});const element=document.createElement('div'),root=createRoot(element);try{await act(async()=>root.render(<LaunchReadiness/>));expect(mockGet).toHaveBeenCalledWith('/v1/checkouts/readiness?cursor=');expect(element.textContent).toContain('SHIRT');expect(element.textContent).toContain('Thiếu trọng lượng giao hàng');expect(element.textContent).toContain('Thiếu giá theo currency');expect(element.textContent).toContain('test');expect(element.querySelectorAll('input')).toHaveLength(0);}finally{await act(async()=>root.unmount());}});
