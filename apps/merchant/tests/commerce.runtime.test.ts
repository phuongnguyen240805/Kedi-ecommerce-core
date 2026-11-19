import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_dev } from 'wrangler';

test(
  'real Worker/DO checkout enforces auth, idempotency, evidence and private tracking',
  { timeout: 90000 },
  async () => {
    const root = resolve(
      fileURLToPath(new URL('../.wrangler/', import.meta.url)),
    );
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'commerce-runtime-'));
    const main = join(dir, 'worker.ts'),
      config = join(dir, 'wrangler.json');
    const source = fileURLToPath(
      new URL('../src/index.ts', import.meta.url),
    ).replaceAll('\\', '/');
    const lib = fileURLToPath(
      new URL('../src/lib/', import.meta.url),
    ).replaceAll('\\', '/');
    writeFileSync(
      main,
      `
 import original,{MerchantDO} from ${JSON.stringify(source)};
 import {hashShipping,policyIdentity,shippingConfiguration,calculateShipping} from ${JSON.stringify(lib + 'smart-shipping.ts')};
 import {pancakeRequest} from ${JSON.stringify(lib + 'commerce-pancake-api.ts')};
 export {MerchantDO};
 export default {async fetch(req,env,ctx){
 if(new URL(req.url).pathname.startsWith('/__test/service/')||new URL(req.url).pathname.startsWith('/__test/finance/')){
 const url=new URL(req.url),finance=url.pathname.startsWith('/__test/finance/');url.pathname=url.pathname.replace(finance?'/__test/finance':'/__test/service','/v1/commerce-service');
 return original.fetch(new Request(url,req),{...env,COMMERCE_SERVICE_ENABLED:'true',COMMERCE_SERVICE_FINANCE_SUBJECTS:finance?'api-key:sk_fixture,api-key:sk_fixture2':''},ctx);
 }
 if(new URL(req.url).pathname==='/__test/action-session'){
 const {order_id}=await req.json(),stub=env.MERCHANT.getByName('default'),session=crypto.randomUUID(),token='b'.repeat(64);
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)),hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 await stub.commerceActionStart(order_id,session,'fixture-code');await stub.commerceActionVerify(order_id,session,'fixture-code',hash);return Response.json({token});
 }
 if(new URL(req.url).pathname==='/__test/pos-boundary'){
 const originalFetch=globalThis.fetch;let calls=0,redirectMode,simulateRedirect=false;
 globalThis.fetch=async(url,init)=>{calls++;const nativeRequest=new Request(url,init);redirectMode=nativeRequest.redirect;
 return simulateRedirect?new Response(null,{status:302,headers:{Location:'https://untrusted.invalid/'}}):Response.json({data:[]});};
 try{const fake={PANCAKE_SHOP_ID:'fixture',PANCAKE_API_KEY:'fixture-secret'};
 const result=await pancakeRequest(fake,'/orders');simulateRedirect=true;let rejected;
 try{await pancakeRequest(fake,'/orders');}catch(error){rejected=error.code;}
 return Response.json({result,calls,redirectMode,rejected});}finally{globalThis.fetch=originalFetch;}
 }
 if(new URL(req.url).pathname==='/__test/shipping-workflow'){
 const stub=env.MERCHANT.getByName('default'),{order_id}=await req.json();
 const overview=(await stub.shippingOverview(order_id)).value,leg=overview.legs[0];
 const before=(await stub.commerceReceipt(order_id)).value;
 const command=(await stub.shippingEnqueue({leg_id:leg.id,kind:'reconcile',idempotency_key:crypto.randomUUID()},'runtime-test')).value;
 const job=await stub.shippingClaim(command.id,'workflow');
 const concurrent=await stub.shippingPollClaim(leg.id,'poll');
 const observation={tracking_code:before.tracking_number,client_code:before.reference,shop_id:1,status:'transporting',updated_at:Date.now(),cod_amount:before.amount_to_collect_vnd};
 const accepted=await stub.shippingObserve(leg.id,observation,'workflow');
 const stale=await stub.shippingObserve(leg.id,{...observation,status:'ready_to_pick',updated_at:observation.updated_at-1},'workflow');
 await stub.shippingFinish(command.id,'workflow','verified','runtime_read_verified');
 const input={source:'ghn',account_id:'legacy-ghn',environment:'staging',external_code:before.tracking_number,event_time:Date.now(),payload_hash:'runtime-'+order_id};
 const event=(await stub.shippingReceive(input)).value,duplicate=(await stub.shippingReceive(input)).value;
 const linked=(await stub.shippingLinkEvent(event.id)).value;
 await stub.shippingFinishEvent(event.id,true);
 return Response.json({claimed:!!job.value,concurrent:concurrent.value,accepted:accepted.value,stale:stale.value,duplicate:duplicate.duplicate,linked:linked.id===leg.id,receipt:(await stub.commerceReceipt(order_id)).value});
 }
 if(new URL(req.url).pathname==='/__test/shipment-rpc'){
 const stub=env.MERCHANT.getByName('default'),{order_id}=await req.json();
 const before=(await stub.commerceReceipt(order_id)).value;
 await stub.commerceClaim(order_id,'pos');await stub.commerceFinish(order_id,'pos',before.reference,null);
 const first=await stub.commerceShipmentClaim(order_id,'shipping');
 const concurrent=await stub.commerceShipmentClaim(order_id,'other');
 await stub.commerceShipmentMark(order_id,'shipping',5,745268);
 await stub.commerceShipmentFinish(order_id,'shipping',{tracking_number:'GHN-TEST-'+order_id,partner_id:5,account_id:745268,partner_status:'request_received'});
 return Response.json({claimed:!!first.value,concurrent:concurrent.value,receipt:(await stub.commerceReceipt(order_id)).value,pending:await stub.commercePending()});
 }
 if(new URL(req.url).pathname!=='/__test/seed')return original.fetch(req,env,ctx);
 const stub=env.MERCHANT.getByName('default'),input=await req.json();
 await stub.commerceOverviewInit();
 const keys=[['pk_fixture','public'],['sk_fixture','admin'],['sk_fixture2','admin']];
 for(const [key,role]of keys){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));const hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');await stub.run('INSERT OR IGNORE INTO api_keys(id,key_hash,key_prefix,role) VALUES(?,?,?,?)',[key,hash,key,role]);}
 await stub.run("INSERT OR IGNORE INTO currencies(id,code,display_name,decimal_places) VALUES('vnd','VND','VND',0)");
 await stub.run("INSERT OR IGNORE INTO products(id,title,status) VALUES('p','Apple','active')");
 await stub.run("INSERT OR IGNORE INTO variants(id,product_id,sku,title,price_cents,currency,weight_g,status) VALUES('v','p','APPLE','Apple',100000,'VND',500,'active')");
 await stub.run("INSERT OR IGNORE INTO variant_prices(id,variant_id,currency_id,price_cents) VALUES('vp','v','vnd',100000)");
 await stub.run("INSERT OR IGNORE INTO warehouses(id,display_name,address_line1,city,postal_code,country_code) VALUES('local-w','Test','Address','City','','VN')");
 await stub.run("INSERT OR IGNORE INTO pancake_links(shop_id,kind,source_id,target_id,seen_token) VALUES('shop','warehouse','w','local-w','1'),('shop','product','pos-p','p','1'),('shop','variation','pos-v','v','1')");
 await stub.run("INSERT OR REPLACE INTO pancake_sync_state(shop_id,warehouse_id,last_completed_at) VALUES('shop','w',?)",[new Date().toISOString()]);
 await stub.run("INSERT OR IGNORE INTO inventory(id,sku,on_hand,reserved) VALUES('i','APPLE',100,0)");
 await stub.run("INSERT OR IGNORE INTO warehouse_inventory(id,sku,warehouse_id,on_hand,reserved) VALUES('wi','APPLE','local-w',100,0)");
 await stub.run("INSERT INTO carts(id,customer_email,currency,expires_at,shipping_name,shipping_line1,shipping_city,shipping_country) VALUES(?,'guest@cart.invalid','VND',?,'Test User','12 Test Street','HCM','VN')",[input.cart_id,new Date(Date.now()+86400000).toISOString()]);
 await stub.run("INSERT INTO cart_items(id,cart_id,sku,title,qty,unit_price_cents,currency) VALUES(?,?,'APPLE','Apple',2,100000,'VND')",[crypto.randomUUID(),input.cart_id]);
 const cfg=shippingConfiguration(env),cart=(await stub.shippingCart(input.cart_id)).value;
 const now=Date.now(),offer={id:'ghn:2',provider:'ghn',service_type_id:2,service_name:'Test',currency:'VND',carrier_fee_vnd:30000,subsidy_vnd:10000,customer_fee_vnd:20000,cod_value_vnd:input.payment_method==='cod'?220000:0,estimated_delivery_at:new Date(now+3600000).toISOString(),fee_breakdown:{total:30000},source:'carrier_api',environment:'staging'};
 const result=await calculateShipping(cart,{cart_id:input.cart_id,destination:{district_id:3,ward_code:'0004'},payment_method:input.payment_method==='cod'?'cod':'prepaid'},cfg,[{code:'fixture',quote:async()=>({offers:[offer],warnings:[]})}]);
 await stub.storeShippingQuote(result.quote);await stub.selectShippingQuote(input.cart_id,result.quote.id,offer.id,await hashShipping(policyIdentity(cfg)));
 return Response.json({seeded:true});
 }};
 `,
    );
    writeFileSync(
      config,
      JSON.stringify({
        name: 'commerce-runtime-test',
        main,
        compatibility_date: '2025-12-01',
        durable_objects: {
          bindings: [{ name: 'MERCHANT', class_name: 'MerchantDO' }],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['MerchantDO'] }],
        kv_namespaces: [{ binding: 'KV_CACHE', id: '0'.repeat(32) }],
        r2_buckets: [{binding:'COMMERCE_EVIDENCE_BUCKET',bucket_name:'commerce-evidence-fixture'}],
        vars: {
          COMMERCE_CHECKOUT_ENABLED: 'true',
          COMMERCE_ENVIRONMENT: 'staging',
          ORDER_TOKEN_SECRET: 'fixture-order-secret-at-least-32-characters',
          TECHCOMBANK_ACCOUNT_NUMBER: '50398838675',
          TECHCOMBANK_ACCOUNT_NAME: 'NGUYEN XUAN PHUONG',
          PANCAKE_SHOP_ID: 'shop',
          PANCAKE_WAREHOUSE_ID: 'w',
          SMART_SHIPPING_ENABLED: 'true',
          SMART_SHIPPING_POLICY: JSON.stringify({
            version: 'fixture',
            max_delivery_hours: 24,
            subsidy_vnd: 10000,
            parcel: {
              length_cm: 25,
              width_cm: 20,
              height_cm: 15,
              max_weight_g: 10000,
            },
          }),
          GHN_ENVIRONMENT: 'staging',
          GHN_TOKEN: 'fixture-token',
          GHN_SHOP_ID: '1',
          GHN_FROM_DISTRICT_ID: '2',
          GHN_FROM_WARD_CODE: '0003',
        },
      }),
    );
    let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
    try {
      worker = await unstable_dev(main, {
        config,
        local: true,
        persist: false,
        port: 0,
        inspectorPort: 0,
        logLevel: 'error',
        experimental: {
          testMode: true,
          disableDevRegistry: true,
          watch: false,
          showInteractiveDevSession: false,
        },
      });
      async function request(path: string, body?: unknown, key = 'sk_fixture') {
        return worker!.fetch(path, {
          method: body ? 'POST' : 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      }
      const posBoundary = await request('/__test/pos-boundary');
      assert.equal(posBoundary.status, 200);
      assert.deepEqual(await posBoundary.json(), { result: { data: [] }, calls: 2, redirectMode: 'manual', rejected: 'pos_unavailable' });
      assert.equal((await request('/v1/setup/init', { keys: [] })).status, 503);
      for (const method of ['cod', 'techcombank_qr']) {
        const input = {
          cart_id: crypto.randomUUID(),
          idempotency_key: crypto.randomUUID(),
          payment_method: method,
          customer_email: 'qa@example.test',
          recipient: {
            name: 'Test User',
            phone: '0901234567',
            address: '12 Test Street',
            city: 'HCM',
            district_id: 3,
            ward_code: '0004',
          },
          expected_total_vnd: 220000,
          note: '',
        };
        assert.equal((await request('/__test/seed', input)).status, 200);
        const dispatchPath = '/v1/commerce/admin/orders/00000000-0000-4000-8000-000000000099/dispatch';
        assert.equal((await request(dispatchPath, { evidence: 'Authorized dispatch fixture' }, 'pk_fixture')).status, 403);
        assert.equal((await request(dispatchPath, { evidence: 'Authorized dispatch fixture' })).status, 404);
        assert.equal(
          (await request('/v1/commerce/checkout/confirm', input, 'pk_fixture'))
            .status,
          403,
        );
        const response = await request('/v1/commerce/checkout/confirm', input);
        assert.equal(response.status, 200, await response.clone().text());
        const order = (await response.json()) as Record<string, unknown>;
        const repeat = await request('/v1/commerce/checkout/confirm', input);
        assert.equal(
          ((await repeat.json()) as Record<string, unknown>).order_id,
          order.order_id,
        );
        const track = { order_id: order.order_id, token: order.tracking_token };
        assert.equal(
          (
            await request(
              '/v1/commerce/track',
              { ...track, token: '0'.repeat(64) },
              'pk_fixture',
            )
          ).status,
          404,
        );
        const tracked = await request(
          '/v1/commerce/track',
          track,
          'pk_fixture',
        );
        assert.equal(tracked.status, 200);
        const body = await tracked.text();
        assert.equal(body.includes('qa@example.test'), false);
        assert.equal(body.includes('12 Test Street'), false);
        assert.equal(tracked.headers.get('Cache-Control'), 'no-store');
        if (method === 'techcombank_qr') {
          assert.equal(order.payment_status, 'pending');
          assert.equal(order.pos_sync_status, 'waiting_payment');
          assert.match(String(order.qr_url), /techcombank-50398838675/);
          const proof = {
            transaction_id: 'TCB-runtime',
            amount_vnd: 220000,
            currency: 'VND',
            reference: order.reference,
            received_at: new Date().toISOString(),
            evidence: 'Bank statement checked by fixture accountant',
          };
          const endpoint =
            '/v1/commerce/admin/orders/' + order.order_id + '/bank_transfer';
          assert.equal(
            (await request(endpoint, proof, 'pk_fixture')).status,
            403,
          );
          assert.equal((await request(endpoint, proof)).status, 200);
          assert.equal((await request(endpoint, proof)).status, 200);
          const paid = await request('/v1/commerce/track', track, 'pk_fixture');
          assert.equal(
            ((await paid.json()) as Record<string, unknown>).payment_status,
            'paid',
          );
        }
        assert.equal(
          (
            await request(
              '/v1/commerce/admin/orders/' + order.order_id + '/sync-pos',
              {},
            )
          ).status,
          503,
        );
        const shipment = await request('/__test/shipment-rpc', { order_id: order.order_id });
        assert.equal(shipment.status, 200);
        const shipmentBody = await shipment.json() as { claimed: boolean; concurrent: unknown; receipt: Record<string, unknown>; pending: { order_id: string }[] };
        assert.equal(shipmentBody.claimed, true);
        assert.equal(shipmentBody.concurrent, null);
        assert.equal(shipmentBody.receipt.shipment_status, 'booked');
        assert.equal(shipmentBody.receipt.fulfillment_status, 'ready_to_ship');
        assert.match(String(shipmentBody.receipt.tracking_number), /^GHN-TEST-/);
        assert.equal(shipmentBody.receipt.payment_status, method === 'cod' ? 'unpaid' : 'paid');
        assert.equal(shipmentBody.pending.some(item => item.order_id === order.order_id), false);
        if(method==='cod'){
          const response=await request('/__test/shipping-workflow',{order_id:order.order_id});
          assert.equal(response.status,200,await response.clone().text());
          const body=await response.json() as {claimed:boolean;concurrent:unknown;accepted:{accepted:boolean};stale:{accepted:boolean};duplicate:boolean;linked:boolean;receipt:{fulfillment_status:string;payment_status:string;cod_status:string}};
          assert.equal(body.claimed,true);assert.equal(body.concurrent,null);assert.equal(body.accepted.accepted,true);assert.equal(body.stale.accepted,false);assert.equal(body.duplicate,true);assert.equal(body.linked,true);assert.equal(body.receipt.fulfillment_status,'shipped');assert.equal(body.receipt.payment_status,'unpaid');assert.equal(body.receipt.cod_status,'to_collect');
          assert.equal((await request('/v1/shipping-operations/orders/'+order.order_id,undefined,'pk_fixture')).status,403);
          assert.equal((await request('/v1/shipping-operations/orders/'+order.order_id)).status,200);
          assert.equal((await request('/v1/shipping-operations/commands',{leg_id:'bad'})).status,400);
          assert.equal((await request('/v1/carrier-events/ghn/unknown',{ShopID:1})).status,401);
        }
        // Real HTTP + Worker + SQLite DO for the new service boundary, without sending email or moving money.
        const paused=await request('/v1/commerce-service/detail',track,'pk_fixture');
        assert.equal(paused.status,200);
        assert.deepEqual(((await paused.json()) as {allowed_actions:unknown}).allowed_actions,{cancel:false,address:false,return:false});
        assert.equal((await request('/v1/commerce-service/verification/start',track,'pk_fixture')).status,503);
        assert.equal((await request('/__test/service/detail',{...track,token:'0'.repeat(64)},'pk_fixture')).status,404);
        const detailResponse=await request('/__test/service/detail',track,'pk_fixture');
        assert.equal(detailResponse.status,200);assert.equal(detailResponse.headers.get('Cache-Control'),'no-store');
        let detail=await detailResponse.json() as {order_version:number;requests:{id:string;status:string}[];refunds:{id:string;amount_vnd:number}[]};
        const draft={kind:'cancel',reason:'Khách yêu cầu hủy đơn, đã xác minh qua email.',order_version:detail.order_version,idempotency_key:crypto.randomUUID(),evidence_ids:[] as string[]};
        assert.equal((await request('/__test/service/requests',{...track,action_token:'a'.repeat(64),request:draft},'pk_fixture')).status,403);
        const session=await request('/__test/action-session',{order_id:order.order_id});
        const {token:actionToken}=await session.json() as {token:string};
        assert.equal((await request('/__test/service/verification/start',track,'pk_fixture')).status,503);
        const recovered=await request('/__test/service/recover',{number:'missing-order',email:'qa@example.test'},'pk_fixture');
        assert.equal(recovered.status,200);
        const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9sAAAAASUVORK5CYII=';
        const uploadBody={...track,action_token:actionToken,mime:'image/png',base64:png};
        const uploaded=await request('/__test/service/evidence',uploadBody,'pk_fixture');
        assert.equal(uploaded.status,200,await uploaded.clone().text());
        const {id:evidenceId}=await uploaded.json() as {id:string};draft.evidence_ids=[evidenceId];
        assert.equal((await request('/__test/service/evidence',uploadBody,'pk_fixture')).status,429);
        const evidencePath=`/__test/service/admin/orders/${order.order_id}/evidence`;
        assert.equal((await request(evidencePath,{evidence_id:evidenceId},'pk_fixture')).status,403);
        const stored=await request(evidencePath,{evidence_id:evidenceId});
        assert.equal(stored.status,200);assert.deepEqual(await stored.json(),{mime:'image/png',base64:png});
        assert.equal((await request('/__test/service/admin/orders/00000000-0000-4000-8000-000000000099/evidence',{evidence_id:evidenceId})).status,404);
        const submitted=await request('/__test/service/requests',{...track,action_token:actionToken,request:draft},'pk_fixture');
        assert.equal(submitted.status,200,await submitted.clone().text());detail=await submitted.json() as typeof detail;
        assert.equal((await request('/__test/service/requests',{...track,action_token:actionToken,request:draft},'pk_fixture')).status,200);
        assert.equal((await request('/__test/service/admin/queue',undefined,'pk_fixture')).status,403);
        const requestId=detail.requests[0].id;
        for(const action of ['approve','complete']){
          const result=await request(`/__test/service/admin/orders/${order.order_id}/decision`,{order_version:detail.order_version,request_id:requestId,action,evidence:'Fixture operator verified POS and carrier are canceled.',external_cleared:true});
          assert.equal(result.status,200,await result.clone().text());detail=await result.json() as typeof detail;
        }
        assert.equal(detail.requests[0].status,'completed');
        const legacy=await worker!.fetch(`/v1/orders/${order.order_id}`,{method:'PATCH',headers:{Authorization:'Bearer sk_fixture','Content-Type':'application/json'},body:JSON.stringify({status:'pending'})});
        assert.equal(legacy.status,409);
        assert.equal((await request(`/__test/service/admin/orders/${order.order_id}/refunds`,{order_version:detail.order_version,idempotency_key:crypto.randomUUID(),amount_vnd:1,reason:'Fixture cannot refund via shared admin key.'})).status,403);
        if(method==='techcombank_qr'){
          assert.equal(detail.refunds.length,1);
          const result={order_version:detail.order_version,refund_id:detail.refunds[0].id,status:'succeeded',reference:'BANK-RUNTIME-REFUND',evidence:'Two authorized fixture accountants verified a bank refund.'};
          assert.equal((await request(`/__test/finance/admin/orders/${order.order_id}/refund-result`,result)).status,409);
          const completed=await request(`/__test/finance/admin/orders/${order.order_id}/refund-result`,result,'sk_fixture2');
          assert.equal(completed.status,200,await completed.clone().text());
          const paidBack=await request('/v1/commerce/track',track,'pk_fixture');
          assert.equal(((await paidBack.json()) as {payment_status:string}).payment_status,'refunded');
        }
        const exceptions=await request('/v1/commerce/admin/exceptions');
        assert.equal(((await exceptions.json()) as {items:{order_id:string}[]}).items.some(item=>item.order_id===order.order_id),false);
      }
      const specResponse = await request('/openapi.json');
      assert.equal(specResponse.status, 200);
      const spec = (await specResponse.json()) as {
        openapi: string;
        paths: Record<string, unknown>;
        components: unknown;
      };
      const paths = Object.fromEntries(
        Object.entries(spec.paths).filter(([path]) =>
          path.startsWith('/v1/commerce/')||path.startsWith('/v1/commerce-service/')||path.startsWith('/v1/shipping-operations/')||path.startsWith('/v1/carrier-events/'),
        ),
      );
      assert.ok(Object.keys(paths).length >= 10);
      const reportRoot = fileURLToPath(
        new URL('../../../outputs/commerce-qa/', import.meta.url),
      );
      mkdirSync(reportRoot, { recursive: true });
      writeFileSync(
        join(reportRoot, 'phase1-openapi.json'),
        JSON.stringify(
          {
            openapi: spec.openapi,
            info: {
              title: 'Fufuni phase 1 local contract snapshot',
              version: '2026-10-14',
            },
            paths,
            components: spec.components,
          },
          null,
          2,
        ),
      );
    } finally {
      await worker?.stop();
      const resolved = resolve(dir);
      assert.ok(
        resolved.startsWith(root + '\\') || resolved.startsWith(root + '/'),
      );
      rmSync(resolved, { recursive: true, force: true });
    }
  },
);
