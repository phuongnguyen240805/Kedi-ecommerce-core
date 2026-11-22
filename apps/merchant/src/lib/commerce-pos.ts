import { z } from 'zod';
import type { Env, DOStub } from '../types';
import { ShippingError } from './smart-shipping';
import { unwrapShipping } from './shipping-store';
import { pancakeRequest as request, pancakeOrderSchema as posOrder, pancakeReference, assertPancakeMoney, parsePancakeOrder } from './commerce-pancake-api';
import { resolvePosAddress } from './commerce-pos-address';

export async function syncCommerceOrder(
  env: Env,
  db: Pick<DOStub, 'commerceClaim' | 'commerceMarkCreate' | 'commerceFinish'>,
  id: string,
) {
  if (env.PANCAKE_ORDER_SYNC_ENABLED !== 'true')
    throw new ShippingError(
      'pos_sync_disabled',
      503,
      'Tự động đồng bộ đơn POS chưa được bật sau nghiệm thu.',
    );
  const token = crypto.randomUUID(),
    job = unwrapShipping(await db.commerceClaim(id, token));
  if (!job) return { synced: true };
  try {
    const { order, snapshot } = job;
    if(snapshot.test_payment&&env.CHECKOUT_TEST_EXPORT_ENABLED!=='true')throw new ShippingError('test_export_disabled',409,'Stripe test orders require explicit export approval');
    if (
      snapshot.shop_id !== env.PANCAKE_SHOP_ID ||
      snapshot.warehouse_id !== env.PANCAKE_WAREHOUSE_ID
    )
      throw new ShippingError(
        'pos_shop_changed',
        409,
        'Shop hoặc kho POS đã đổi.',
      );
    if (
      order.payment_method !== 'cod' &&
      env.PANCAKE_PAYMENT_MAPPING_VERIFIED !== 'true'
    )
      throw new ShippingError(
        'pos_payment_unverified',
        503,
        'Cần nghiệm thu trường chuyển khoản của POS trước đồng bộ prepaid.',
      );
    let found: z.infer<typeof posOrder> | undefined;
    // Search uses custom reference; only exact matches are accepted.
    for (let page = 1; page <= 10; page++) {
      const raw = await request(
        env,
        `/orders?search=${encodeURIComponent(order.reference)}&page_size=100&page_number=${page}&include_removed=1`,
      );
      const list = z.object({ data: z.array(posOrder) }).parse(raw).data;
      const matches = list.filter((o) => pancakeReference(o) === order.reference);
      if (matches.length > 1)
        throw new ShippingError(
          'pos_duplicate_reference',
          409,
          'Pancake có nhiều đơn cùng tham chiếu.',
        );
      if (matches.length) {
        found = matches[0];
        break;
      }
      if (list.length < 100) break;
      if (page === 10)
        throw new ShippingError(
          'pos_search_incomplete',
          503,
          'Chưa tra cứu hết đơn POS.',
        );
    }
    if (!found) {
      if (Number(job.create_attempted))
        throw new ShippingError(
          'pos_create_uncertain',
          409,
          'Lần tạo trước chưa rõ kết quả. Chỉ tra cứu lại; cần nhân viên xử lý khi POS chưa có đơn.',
        );
      const r = snapshot.recipient;
      const address = await resolvePosAddress(env, r);
      const payload = {
        shop_id: Number(env.PANCAKE_SHOP_ID),
        custom_id: order.reference,
        status: 1,
        warehouse_id: snapshot.warehouse_id,
        bill_full_name: r.name,
        bill_phone_number: r.phone,
        bill_email: snapshot.customer_email,
        order_currency: 'VND',
        shipping_address: address,
        shipping_fee: snapshot.totals.shipping_vnd,
        customer_pay_fee: true,
        discount: 0,
        tax: snapshot.tax_inclusive ? 0 : snapshot.totals.tax_vnd,
        cash: 0,
        charged_by_card:order.payment_method==='stripe'?order.total_vnd:0,
        transfer_money:
          order.payment_method === 'techcombank_qr' ? order.total_vnd : 0,
        note: `Fufuni ${order.reference}; payment=${order.payment_method}; test=${!!snapshot.test_payment}; dispatch=Pancake; ${snapshot.note}; GHN district=${r.district_id}, ward=${r.ward_code}; theo dõi vận đơn qua Pancake`,
        items: snapshot.items.map(
          (i: {
            pos_variant_id: string;
            pos_product_id: string;
            qty: number;
            unit_price_vnd: number;
            title: string;
            weight_g?: number;
          }) => ({
            variation_id: i.pos_variant_id,
            product_id: i.pos_product_id,
            quantity: i.qty,
            variation_info: { name: i.title, retail_price: i.unit_price_vnd, weight: i.weight_g },
          }),
        ),
      };
      // Persist the attempt only after all read-only validation succeeds.
      unwrapShipping(await db.commerceMarkCreate(id, token));
      const raw = await request(env, '/orders', payload);
      const wrapped = z.object({ data: posOrder }).safeParse(raw);
      found = wrapped.success ? wrapped.data.data : posOrder.parse(raw);
    }
    // POST may acknowledge values before all computed fields are persisted.
    found = parsePancakeOrder(await request(env, '/orders/' + encodeURIComponent(String(found.id))));
    assertPancakeMoney(found, order);
    if ([6, 7].includes(Number(found.status)))
      throw new ShippingError('pos_order_canceled', 409, 'Đơn tham chiếu trên Pancake đã hủy hoặc xóa.');
    unwrapShipping(await db.commerceFinish(id, token, String(found.id), null));
    return { synced: true };
  } catch (error) {
    const code =
      error instanceof ShippingError ? error.code : 'pos_response_unverified';
    unwrapShipping(await db.commerceFinish(id, token, null, code));
    throw new ShippingError(
      code,
      502,
      'Đồng bộ POS cần kiểm tra. Đơn và thanh toán đã được giữ lại.',
    );
  }
}
