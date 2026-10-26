import {test} from 'node:test';
import assert from 'node:assert/strict';
import {destinationSchema} from '../src/lib/smart-shipping';
import {checkoutInput} from '../src/lib/commerce-core';
test('GHN alphanumeric ward codes are accepted by shipping and checkout contracts',()=>{
 for(const ward_code of ['0004','1B2516']){
  assert.equal(destinationSchema.safeParse({district_id:1806,ward_code}).success,true);
  assert.equal(checkoutInput.safeParse({cart_id:crypto.randomUUID(),idempotency_key:crypto.randomUUID(),payment_method:'techcombank_qr',customer_email:'qa@example.test',recipient:{name:'QA User',phone:'0901234567',address:'12 Test Street',city:'Ha Noi',district_id:1806,ward_code},expected_total_vnd:220000}).success,true);
 }
 for(const ward_code of ['../ward','1B 2516','<script>',''])assert.equal(destinationSchema.safeParse({district_id:1806,ward_code}).success,false);
});
