import type {DOStub} from '../types';
import {ShippingError} from './smart-shipping';
import type {CheckoutRpcCommand} from './checkout-core';
export async function callCheckout(db:DOStub,command:CheckoutRpcCommand){const result=await db.checkoutRpc(command);if(!result.ok)throw new ShippingError(result.error.code,result.error.status,result.error.message);return result.value;}
