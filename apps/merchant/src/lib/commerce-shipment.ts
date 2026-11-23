import { z } from 'zod';
import type { Env, DOStub } from '../types';
import { pancakeRequest, parsePancakeOrder, assertPancakeMoney, pancakeReference } from './commerce-pancake-api';
import { resolvePosAddress } from './commerce-pos-address';
import { syncCommerceOrder } from './commerce-pos';
import { unwrapShipping } from './shipping-store';
import { ShippingError } from './smart-shipping';
import {processShippingWork} from './shipping-runner';

type ShipmentDB = Pick<DOStub, 'commerceShipmentClaim' | 'commerceShipmentMark' | 'commerceShipmentFinish'>;
const partnerSchema = z.object({
  partner_id: z.number().int(), extend_code: z.string().nullish(),
  partner_status: z.string().nullish(), system_created: z.boolean().nullish(),
}).passthrough();
const partnersSchema = z.object({ data: z.array(z.object({ id: z.number().int(), name: z.string(), accounts: z.array(z.object({ id: z.number().int() })) })) });

export async function syncCommerceShipment(env: Env, db: ShipmentDB, id: string) {
  if (env.PANCAKE_ORDER_SYNC_ENABLED !== 'true') return;
  const token = crypto.randomUUID();
  const job = unwrapShipping(await db.commerceShipmentClaim(id, token));
  if (!job) return;
  let observedStatus: number | undefined;
  try {
    const { snapshot, order, pos_id } = job;
    if (snapshot.shop_id !== env.PANCAKE_SHOP_ID || snapshot.warehouse_id !== env.PANCAKE_WAREHOUSE_ID)
      throw new ShippingError('pos_shop_changed', 409, 'Shop hoặc kho đã thay đổi.');
    const path = '/orders/' + encodeURIComponent(pos_id);
    const observe = (pos: ReturnType<typeof parsePancakeOrder>) => {
      if (String(pos.id) !== pos_id || pancakeReference(pos) !== order.reference)
        throw new ShippingError('pos_order_mismatch', 409, 'Tham chiếu đơn POS không khớp.');
      const status = Number(pos.status);
      if (Number.isInteger(status) && pos.status != null) observedStatus = status;
    };
    const initial = parsePancakeOrder(await pancakeRequest(env, path));
    observe(initial);
    if ([4, 5, 6, 7, 15].includes(observedStatus!)) {
      unwrapShipping(await db.commerceShipmentFinish(id, token, { pos_status: observedStatus, awaiting_dispatch: true }));
      return;
    }
    if (snapshot.shipping?.offer?.provider !== 'ghn' || snapshot.shipping.offer.environment !== 'production' || env.COMMERCE_ENVIRONMENT !== 'production')
      throw new ShippingError('shipment_environment_mismatch', 409, 'Chỉ gửi báo giá GHN production qua Pancake production.');
    if(snapshot.shipping.offer.execution_owner==='direct')throw new ShippingError('shipment_owner_mismatch',409,'Vận đơn do Fufuni thực thi không được gửi qua Pancake.');
    const accountId = Number(env.PANCAKE_GHN_ACCOUNT_ID);
    if (!Number.isSafeInteger(accountId) || accountId <= 0)
      throw new ShippingError('shipment_account_missing', 503, 'Chưa chọn tài khoản GHN trong Pancake.');
    if (snapshot.dispatch_account_id !== String(accountId))
      throw new ShippingError('shipment_account_changed', 409, 'Tài khoản GHN đã đổi sau khi đặt đơn.');
    if(snapshot.shipping.offer.pos_account_id&&snapshot.shipping.offer.pos_account_id!==accountId)throw new ShippingError('shipment_account_changed',409,'Tài khoản POS không khớp tài khoản đã chọn trong báo giá.');
    const connections = partnersSchema.parse(await pancakeRequest(env, '/partners')).data;
    const candidates = connections.filter(p => p.name.toUpperCase() === 'GHN' && p.accounts.some(a => a.id === accountId));
    if (candidates.length !== 1) throw new ShippingError('shipment_account_unlinked', 409, 'Tài khoản GHN không còn kết nối với shop.');
    const partnerId = candidates[0].id;
    if(snapshot.shipping.offer.pos_partner_id&&snapshot.shipping.offer.pos_partner_id!==partnerId)throw new ShippingError('shipment_partner_changed',409,'Mã hãng POS khác với báo giá đã xác nhận.');
    const read = async (existing?: ReturnType<typeof parsePancakeOrder>) => {
      const pos = existing || parsePancakeOrder(await pancakeRequest(env, path));
      observe(pos);
      assertPancakeMoney(pos, order);
      if (String(pos.id) !== pos_id)
        throw new ShippingError('pos_money_mismatch', 409, 'Tham chiếu hoặc số tiền POS thay đổi.');
      if ([6, 7].includes(Number(pos.status))) throw new ShippingError('pos_order_canceled', 409, 'Đơn POS đã hủy hoặc xóa.');
      const parsed = partnerSchema.nullish().parse(pos.partner);
      if (parsed && parsed.partner_id !== partnerId) throw new ShippingError('shipment_partner_changed', 409, 'Đơn POS đã chọn hãng vận chuyển khác.');
      if (pos.shop_partner_id != null && Number(pos.shop_partner_id) !== accountId)
        throw new ShippingError('shipment_account_changed', 409, 'Đơn POS đã chọn tài khoản vận chuyển khác.');
      return { pos, partner: parsed };
    };
    let current = await read(initial);
    if (!current.partner?.extend_code) {
      if ([2, 3, 16].includes(observedStatus!)) {
        // A shipped/received POS order must never trigger a new carrier booking.
        unwrapShipping(await db.commerceShipmentFinish(id, token, { pos_status: observedStatus, awaiting_dispatch: true }));
        return;
      }
      // A previous request may have reached GHN. Never repeat it after timeout or a missing label.
      if (job.attempted || current.pos.is_linked_partner === true || current.pos.time_send_partner)
        throw new ShippingError('shipment_result_uncertain', 409, 'Pancake chưa trả mã vận đơn. Cần tra cứu lại, không tự gửi trùng.');
      if (env.PANCAKE_GHN_DISPATCH_ENABLED !== 'true' || !snapshot.dispatch_enabled) {
        unwrapShipping(await db.commerceShipmentFinish(id, token, { awaiting_dispatch: true, pos_status: observedStatus }));
        return;
      }
      const address = await resolvePosAddress(env, snapshot.recipient);
      const parcel = z.object({ length_cm: z.number().positive(), width_cm: z.number().positive(), height_cm: z.number().positive(), weight_g: z.number().positive() }).parse(snapshot.parcel);
      const type = snapshot.shipping.offer.service_type_id;
      if (![2, 5].includes(type)) throw new ShippingError('shipment_service_unsupported', 409, 'Dịch vụ GHN chưa được hỗ trợ.');
      const items = z.array(z.object({ quantity: z.number().int().positive(), variation_info: z.object({ weight: z.number().int().positive() }) })).parse(current.pos.items);
      if (items.reduce((sum, item) => sum + item.quantity * item.variation_info.weight, 0) + (snapshot.checkout_session_id?Number(snapshot.parcel.packaging_weight_g||0):0) !== parcel.weight_g)
        throw new ShippingError('shipment_weight_mismatch', 409, 'Khối lượng kiện POS không khớp báo giá. Cần kiểm tra đóng gói.');
      unwrapShipping(await db.commerceShipmentMark(id, token, partnerId, accountId));
      // Pancake's own order form submits these GHN options when saving an order.
      // The legacy MCP /send-to-partner endpoint returns 404 and must not be used.
      await pancakeRequest(env, path, {
        partner: { partner_id: partnerId }, shop_partner_id: accountId,
        warehouse_id: snapshot.warehouse_id, shipping_address: address,
        // Saving GHN options without these resets the customer shipping fee to zero.
        shipping_fee: snapshot.totals.shipping_vnd, is_free_shipping: false, customer_pay_fee: true,
        is_send_to_ghn: true, is_free_ship_ghn: true,
        service_ghn: type === 2 ? 'ecommerce' : 'traditional',
        cd_ghn: parcel.length_cm, cr_ghn: parcel.width_cm, cc_ghn: parcel.height_cm,
      }, 'PUT');
      current = await read();
    }
    const tracking = current.partner?.extend_code?.trim();
    if (!tracking || tracking.length > 100 || current.partner?.system_created !== true)
      throw new ShippingError('shipment_not_confirmed', 502, 'Pancake chưa xác nhận vận đơn tạo qua hãng.');
    unwrapShipping(await db.commerceShipmentFinish(id, token, {
      tracking_number: tracking, partner_id: partnerId, account_id: accountId,
      partner_status: current.partner?.partner_status || undefined,
      pos_status: observedStatus,
    }));
  } catch (error) {
    const code = error instanceof ShippingError ? error.code : 'shipment_response_unverified';
    unwrapShipping(await db.commerceShipmentFinish(id, token, { error: code, pos_status: observedStatus }));
    throw new ShippingError(code, 502, 'Shop cần kiểm tra vận đơn Pancake. Đơn đã được giữ lại.');
  }
}

export async function processCommerceOrder(env: Env, db: DOStub, id: string) {
  await syncCommerceOrder(env, db, id);
  const leg=unwrapShipping(await db.shippingBootstrap(id,env.SHIPPING_AUTOMATION_ENABLED==='true'));
  if(leg.owner==='pancake')await syncCommerceShipment(env, db, id);
  else await processShippingWork(env,db);
  return { synced: true };
}
