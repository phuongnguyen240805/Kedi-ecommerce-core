import { z } from 'zod';
import type { Env, DOStub } from '../types';
import {
  carrierAccounts,
  carrierConfiguration,
  type CarrierAccount,
} from './shipping-registry';
import {
  ghnExecutionAdapter,
  commandSatisfied,
  CarrierRejection,
  type ExecutionAdapter,
} from './shipping-ghn';
import { type Leg, type Command, type CarrierObservation } from './shipping-workflow';
import { ShippingError } from './smart-shipping';
import { unwrapShipping } from './shipping-store';
import {
  pancakeRequest,
  parsePancakeOrder,
  assertPancakeMoney,
} from './commerce-pancake-api';
import { resolvePosAddress } from './commerce-pos-address';
import { checkoutInput } from './commerce-core';

type Hooks = {
  adapter?: (account: CarrierAccount) => ExecutionAdapter;
  mirror?: (leg: Leg, command: Command, observation: CarrierObservation) => Promise<void>;
  preflight?: (leg: Leg) => Promise<void>;
};
function resolveAccount(env: Env, leg: Leg) {
  const account = carrierAccounts(env).find(
    (a) =>
      a.id === leg.account_id &&
      a.carrier_id === leg.carrier_id &&
      a.environment === leg.environment &&
      a.execution_owner === leg.owner,
  );
  if (!account || account.warehouse_id !== env.PANCAKE_WAREHOUSE_ID)
    throw new ShippingError(
      'carrier_account_unmapped',
      409,
      'Cần xác minh ánh xạ tài khoản vận chuyển; không tự đổi owner.',
    );
  return account;
}
function adapterFor(env: Env, account: CarrierAccount, hooks: Hooks) {
  return hooks.adapter
    ? hooks.adapter(account)
    : ghnExecutionAdapter(carrierConfiguration(env, account));
}

async function assertPosDispatchable(env: Env, db: DOStub, leg: Leg) {
  const state = unwrapShipping(await db.commerceServiceSnapshot(leg.order_id)),
    order = unwrapShipping(await db.commerceReceipt(leg.order_id));
  if (
    !state.pos_id ||
    state.snapshot.shop_id !== env.PANCAKE_SHOP_ID ||
    state.snapshot.warehouse_id !== env.PANCAKE_WAREHOUSE_ID
  )
    throw new ShippingError(
      'pos_shop_changed',
      409,
      'Shop/kho POS không khớp đơn đã xác nhận.',
    );
  const pos = parsePancakeOrder(
    await pancakeRequest(env, '/orders/' + encodeURIComponent(state.pos_id)),
  );
  assertPancakeMoney(pos, order);
  const partner = z
    .object({ extend_code: z.string().nullish() })
    .nullish()
    .parse(pos.partner);
  if (
    String(pos.id) !== state.pos_id ||
    [2, 3, 4, 5, 6, 7, 15, 16].includes(Number(pos.status)) ||
    partner?.extend_code ||
    pos.is_linked_partner === true ||
    pos.time_send_partner
  )
    throw new ShippingError(
      'pos_dispatch_conflict',
      409,
      'POS đã đổi trạng thái hoặc có booking; cần tra cứu trước.',
    );
  if (
    pos.warehouse_id != null &&
    String(pos.warehouse_id) !== state.snapshot.warehouse_id
  )
    throw new ShippingError('pos_warehouse_changed', 409, 'Kho xử lý POS đã thay đổi.');
  const items = z
    .array(
      z.object({
        variation_id: z.string(),
        product_id: z.string(),
        quantity: z.number().int().positive(),
      }),
    )
    .parse(pos.items);
  if (
    items.length !== state.snapshot.items.length ||
    state.snapshot.items.some(
      (item: { pos_variant_id: string; pos_product_id: string; qty: number }) =>
        items.filter(
          (i) =>
            i.variation_id === item.pos_variant_id &&
            i.product_id === item.pos_product_id &&
            i.quantity === item.qty,
        ).length !== 1,
    )
  )
    throw new ShippingError(
      'pos_items_changed',
      409,
      'Sản phẩm hoặc số lượng POS đã thay đổi.',
    );
  const expected = await resolvePosAddress(
    env,
    state.snapshot.recipient,
    carrierConfiguration(env, resolveAccount(env, leg)),
  );
  const actual = z.record(z.string(), z.unknown()).parse(pos.shipping_address);
  for (const key of [
    'full_name',
    'phone_number',
    'address',
    'province_id',
    'district_id',
    'commune_id',
  ] as const)
    if (actual[key] !== expected[key])
      throw new ShippingError(
        'pos_address_changed',
        409,
        'Địa chỉ POS đã thay đổi; cần báo giá và xác nhận lại trước khi gửi hàng.',
      );
}

async function cancelUnbookedPos(env: Env, db: DOStub, leg: Leg) {
  const receipt = unwrapShipping(await db.commerceReceipt(leg.order_id));
  const { pos_id } = unwrapShipping(await db.commerceServiceSnapshot(leg.order_id));
  if (!pos_id)
    throw new ShippingError('pos_order_missing', 409, 'Chưa xác minh đơn POS.');
  const path = '/orders/' + encodeURIComponent(pos_id);
  const read = async () => {
    const pos = parsePancakeOrder(await pancakeRequest(env, path));
    assertPancakeMoney(pos, receipt);
    const partner = z
      .object({ extend_code: z.string().nullish() })
      .nullish()
      .parse(pos.partner);
    if (
      String(pos.id) !== pos_id ||
      partner?.extend_code ||
      pos.is_linked_partner === true ||
      pos.time_send_partner ||
      [2, 3, 4, 5, 15, 16].includes(Number(pos.status))
    )
      throw new ShippingError(
        'pos_booking_uncertain',
        409,
        'POS có dấu hiệu đã chuyển hàng; cần tra cứu thủ công.',
      );
    return pos;
  };
  const before = await read();
  if (![6, 7].includes(Number(before.status)))
    await pancakeRequest(env, path, { status: 6 }, 'PUT');
  if (![6, 7].includes(Number((await read()).status)))
    throw new ShippingError('pos_cancel_unconfirmed', 502, 'POS chưa xác nhận hủy.');
}

// Mirror only after an authenticated read of the carrier. No dispatch flags are
// sent to POS for direct-owned labels, so POS cannot book a second label.
export async function mirrorShippingToPos(
  env: Env,
  db: DOStub,
  leg: Leg,
  command: Command,
  observation: CarrierObservation,
) {
  // Reverse/replacement labels have their own POS documents. Never overwrite
  // the original sale's tracking or fulfillment with another leg.
  if (leg.kind !== 'outbound') return;
  if (env.PANCAKE_TRACKING_MIRROR_VERIFIED !== 'true')
    throw new ShippingError(
      'pos_mirror_unverified',
      409,
      'Chưa nghiệm thu ánh xạ mã vận đơn ngoài vào POS.',
    );
  const account = resolveAccount(env, leg);
  if (!account.pancake_partner_id)
    throw new ShippingError(
      'pos_partner_unmapped',
      409,
      'Chưa xác minh mã đối tác POS cho tài khoản.',
    );
  const receipt = unwrapShipping(await db.commerceReceipt(leg.order_id));
  const { pos_id } = unwrapShipping(await db.commerceServiceSnapshot(leg.order_id));
  if (!pos_id)
    throw new ShippingError('pos_order_missing', 409, 'Chưa liên kết đơn POS.');
  const path = '/orders/' + encodeURIComponent(pos_id);
  const payload = JSON.parse(command.payload);
  const target =
    command.kind === 'address'
      ? {
          ...receipt,
          total_vnd: payload.total_vnd,
          amount_to_collect_vnd: payload.cod_amount,
        }
      : receipt;
  const read = async () => {
    const pos = parsePancakeOrder(await pancakeRequest(env, path));
    try {
      assertPancakeMoney(pos, receipt);
    } catch {
      assertPancakeMoney(pos, target);
    }
    if (String(pos.id) !== pos_id)
      throw new ShippingError('pos_order_mismatch', 409, 'Đơn POS không khớp.');
    return pos;
  };
  const pos = await read();
  const partner = z
    .object({ partner_id: z.number().int(), extend_code: z.string().nullish() })
    .nullish()
    .parse(pos.partner);
  if (
    partner &&
    (partner.partner_id !== account.pancake_partner_id ||
      (partner.extend_code && partner.extend_code !== observation.tracking_code))
  )
    throw new ShippingError(
      'pos_tracking_conflict',
      409,
      'POS đã liên kết vận đơn khác.',
    );
  let status: number | undefined;
  if (observation.status === 'cancel') status = 6;
  else if (observation.status === 'returned') status = 5;
  else if (observation.status === 'delivered') status = 3;
  else if (
    [
      'picked',
      'storing',
      'sorting',
      'transporting',
      'delivering',
      'money_collect_delivering',
      'delivery_fail',
    ].includes(observation.status)
  )
    status = 2;
  const posStatus = Number(pos.status);
  if (
    [3, 4, 5, 6, 7, 15, 16].includes(posStatus) &&
    status !== undefined &&
    status !== posStatus &&
    !(posStatus === 16 && status === 3)
  )
    throw new ShippingError(
      'pos_terminal_conflict',
      409,
      'Trạng thái POS và hãng mâu thuẫn; cần đối soát.',
    );
  let address: Awaited<ReturnType<typeof resolvePosAddress>> | undefined;
  if (command.kind === 'address') {
    const cfg = carrierConfiguration(env, account);
    address = await resolvePosAddress(
      env,
      checkoutInput.shape.recipient.parse(payload.recipient),
      cfg,
    );
  }
  const needsTracking = !partner?.extend_code;
  if (needsTracking || (status !== undefined && status !== posStatus) || address) {
    if (
      address &&
      receipt.payment_method === 'techcombank_qr' &&
      env.PANCAKE_PAYMENT_MAPPING_VERIFIED !== 'true'
    )
      throw new ShippingError(
        'pos_payment_unverified',
        409,
        'Chưa nghiệm thu ánh xạ trả trước POS.',
      );
    await pancakeRequest(
      env,
      path,
      {
        ...(needsTracking
          ? {
              partner: {
                partner_id: account.pancake_partner_id,
                extend_code: observation.tracking_code,
              },
            }
          : {}),
        ...(status !== undefined && status !== posStatus ? { status } : {}),
        ...(address
          ? {
              shipping_address: address,
              shipping_fee: payload.shipping_vnd,
              customer_pay_fee: true,
              transfer_money:
                receipt.payment_method === 'techcombank_qr' ? payload.total_vnd : 0,
            }
          : {}),
      },
      'PUT',
    );
  }
  const confirmed = await read();
  assertPancakeMoney(confirmed, target);
  const after = z
    .object({ partner_id: z.number(), extend_code: z.string() })
    .parse(confirmed.partner);
  if (
    after.partner_id !== account.pancake_partner_id ||
    after.extend_code !== observation.tracking_code ||
    (status !== undefined && Number(confirmed.status) !== status)
  )
    throw new ShippingError(
      'pos_mirror_unconfirmed',
      502,
      'Chưa đọc lại được kết quả đồng bộ POS.',
    );
  if (address) {
    const actual = z.record(z.string(), z.unknown()).parse(confirmed.shipping_address);
    for (const key of [
      'full_name',
      'phone_number',
      'address',
      'province_id',
      'district_id',
      'commune_id',
    ] as const)
      if (actual[key] !== address[key])
        throw new ShippingError(
          'pos_address_unconfirmed',
          502,
          'POS chưa xác nhận địa chỉ mới.',
        );
  }
}

export async function runShippingCommand(
  env: Env,
  db: DOStub,
  id: string,
  hooks: Hooks = {},
) {
  const token = crypto.randomUUID(),
    job = unwrapShipping(await db.shippingClaim(id, token));
  if (!job) return null;
  const { leg, command } = job;
  let attempted = !!command.attempted;
  const finish = async (
    state: 'verified' | 'unknown' | 'rejected' | 'manual_review' | 'awaiting_auth',
    reason: string,
  ) => unwrapShipping(await db.shippingFinish(id, token, state, reason));
  try {
    const account = resolveAccount(env, leg),
      adapter = adapterFor(env, account, hooks);
    const data = unwrapShipping(await db.commerceServiceSnapshot(leg.order_id));
    const frozen = data.snapshot.shipping?.offer;
    const binding =
      leg.kind === 'outbound'
        ? frozen?.account_binding
        : JSON.parse((leg as Leg & { binding_json?: string }).binding_json || 'null');
    if (
      binding &&
      (binding.shop_id !== account.shop_id ||
        binding.warehouse_id !== account.warehouse_id ||
        binding.from_district_id !== account.from_district_id ||
        binding.from_ward_code !== account.from_ward_code)
    )
      return await finish('manual_review', 'carrier_account_changed');
    if (command.kind === 'cancel' && JSON.parse(command.payload).unbooked) {
      if (
        leg.owner !== 'direct' ||
        env.SHIPPING_AUTOMATION_ENABLED !== 'true' ||
        !account.verified
      )
        return await finish('manual_review', 'unbooked_cancellation_not_verified');
      try {
        await adapter.read(leg);
        return await finish('manual_review', 'unexpected_carrier_booking');
      } catch (e) {
        if (!(e instanceof ShippingError) || e.code !== 'carrier_order_not_found')
          throw e;
      }
      if (!attempted) {
        unwrapShipping(await db.shippingMark(id, token));
        attempted = true;
      }
      await cancelUnbookedPos(env, db, leg);
      await finish('verified', 'carrier_and_pos_verified');
      try {
        unwrapShipping(await db.shippingServiceComplete(id));
      } catch {
        return { state: 'verified', service_completion: 'needs_review' };
      }
      return { state: 'verified' };
    }
    let current: CarrierObservation | null = null;
    if (command.kind !== 'create' || attempted || leg.tracking_code) {
      current = await adapter.read(leg);
      const result = unwrapShipping(await db.shippingObserve(leg.id, current, token));
      if (!result.accepted)
        return await finish('manual_review', 'carrier_observation_conflict');
    }
    if (
      !current ||
      !commandSatisfied(command, current) ||
      (command.kind === 'redelivery' && !attempted)
    ) {
      if (command.kind === 'reconcile')
        return await finish('manual_review', 'tracking_unconfirmed');
      if (attempted) return await finish('unknown', 'awaiting_carrier_reconciliation');
      if (leg.owner !== 'direct')
        return await finish(
          'manual_review',
          'pancake_owned_operation_requires_verified_connector',
        );
      if (
        env.SHIPPING_AUTOMATION_ENABLED !== 'true' ||
        !account.enabled ||
        !account.verified ||
        !account.capabilities.includes(command.kind as 'create')
      )
        return await finish('manual_review', 'carrier_capability_not_verified');
      if (command.kind === 'create' && env.PANCAKE_TRACKING_MIRROR_VERIFIED !== 'true')
        return await finish('manual_review', 'pos_mirror_unverified');
      const prepared = await adapter.prepare(leg, command, current);
      if (command.kind === 'create')
        await (hooks.preflight
          ? hooks.preflight(leg)
          : assertPosDispatchable(env, db, leg));
      unwrapShipping(await db.shippingMark(id, token));
      attempted = true;
      await adapter.send(prepared);
      current = await adapter.read(leg);
      if (!unwrapShipping(await db.shippingObserve(leg.id, current, token)).accepted)
        return await finish('manual_review', 'carrier_observation_conflict');
      if (!commandSatisfied(command, current))
        return await finish('unknown', 'awaiting_carrier_reconciliation');
    }
    await (hooks.mirror
      ? hooks.mirror(leg, command, current)
      : mirrorShippingToPos(env, db, leg, command, current));
    await finish('verified', 'carrier_and_pos_verified');
    try {
      unwrapShipping(await db.shippingServiceComplete(id));
    } catch {
      return { state: 'verified', service_completion: 'needs_review' };
    }
    return { state: 'verified' };
  } catch (error) {
    const code =
      error instanceof ShippingError ? error.code : 'carrier_response_unverified';
    if (error instanceof CarrierRejection)
      return await finish(
        code === 'carrier_awaiting_auth' ? 'awaiting_auth' : 'rejected',
        code,
      );
    return await finish(attempted ? 'unknown' : 'manual_review', code);
  }
}

export async function reconcileShippingLeg(
  env: Env,
  db: DOStub,
  leg: Leg,
  hooks: Hooks = {},
) {
  const token = crypto.randomUUID();
  const claimed = unwrapShipping(await db.shippingPollClaim(leg.id, token));
  if (!claimed) return null;
  let error: string | null = null;
  try {
    const account = resolveAccount(env, claimed),
      observation = await adapterFor(env, account, hooks).read(claimed);
    if (
      !unwrapShipping(await db.shippingObserve(claimed.id, observation, token)).accepted
    )
      throw new ShippingError(
        'carrier_observation_conflict',
        409,
        'Trạng thái vận chuyển cần đối soát.',
      );
    const command = {
      id: 'observation',
      leg_id: claimed.id,
      kind: 'reconcile',
      payload: '{}',
      state: 'running',
      attempted: 0,
      lease_token: token,
      request_id: null,
      actor: 'carrier',
    } as Command;
    await (hooks.mirror
      ? hooks.mirror(claimed, command, observation)
      : mirrorShippingToPos(env, db, claimed, command, observation));
    return observation;
  } catch (e) {
    error = e instanceof ShippingError ? e.code : 'carrier_reconciliation_failed';
    throw e;
  } finally {
    await db.shippingPollFinish(claimed.id, token, error);
  }
}
export async function processShippingWork(env: Env, db: DOStub) {
  const service = await db.shippingServiceDue();
  for (const id of service.completions) {
    try {
      unwrapShipping(await db.shippingServiceComplete(id));
    } catch {
      /* Money/QC hold remains visible. */
    }
  }
  if (env.SHIPPING_AUTOMATION_ENABLED === 'true')
    for (const id of service.requests) unwrapShipping(await db.shippingQueueApproved(id));
  for (const id of await db.shippingDue()) await runShippingCommand(env, db, id);
  for (const event of await db.shippingEventsDue()) {
    const leg = unwrapShipping(await db.shippingLinkEvent(String(event.id)));
    if (!leg) continue;
    try {
      if (event.source === 'pancake') {
        const { pos_id } = unwrapShipping(await db.commerceServiceSnapshot(leg.order_id));
        if (!pos_id)
          throw new ShippingError('pos_order_missing', 409, 'Không tìm thấy đơn POS.');
        const pos = parsePancakeOrder(
          await pancakeRequest(env, '/orders/' + encodeURIComponent(pos_id)),
        );
        const receipt = unwrapShipping(await db.commerceReceipt(leg.order_id));
        assertPancakeMoney(pos, receipt);
        if (String(pos.id) !== pos_id)
          throw new ShippingError('pos_order_mismatch', 409, 'Đơn POS không khớp.');
        const address = z
          .object({
            full_name: z.string(),
            phone_number: z.string(),
            address: z.string(),
          })
          .safeParse(pos.shipping_address);
        const partner = z
          .object({ extend_code: z.string().nullish() })
          .nullish()
          .parse(pos.partner);
        const command = unwrapShipping(
          await db.shippingPosObservation(leg.id, {
            status: z.number().int().parse(pos.status),
            tracking: partner?.extend_code || null,
            ...(address.success
              ? {
                  recipient: {
                    name: address.data.full_name,
                    phone: address.data.phone_number,
                    address: address.data.address,
                  },
                }
              : {}),
          }),
        );
        if (command && 'id' in command && env.SHIPPING_AUTOMATION_ENABLED === 'true')
          await runShippingCommand(env, db, String(command.id));
      } else if (!(await reconcileShippingLeg(env, db, leg)))
        throw new ShippingError(
          'shipping_leg_busy',
          409,
          'Đang có thao tác trên vận đơn.',
        );
      await db.shippingFinishEvent(String(event.id), true);
    } catch {
      await db.shippingFinishEvent(String(event.id), false);
    }
  }
  for (const leg of await db.shippingPollDue()) {
    try {
      await reconcileShippingLeg(env, db, leg);
    } catch {
      /* Durable command/inbox state remains available to operators. */
    }
  }
}
