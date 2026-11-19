import { z } from 'zod';
import { readJson } from './read-json';
import { ghnRequest } from './ghn-shipping';
import { ShippingError, type ShippingConfig } from './smart-shipping';
import { checkoutInput } from './commerce-core';
import {
  observationSchema,
  type CarrierObservation,
  type Command,
  type Leg,
} from './shipping-workflow';

export class CarrierRejection extends ShippingError {}
export interface ExecutionAdapter {
  read(leg: Leg): Promise<CarrierObservation>;
  prepare(
    leg: Leg,
    command: Command,
    current: CarrierObservation | null,
  ): Promise<{ path: string; body: unknown }>;
  send(prepared: { path: string; body: unknown }): Promise<void>;
}
const detailSchema = z.object({
  order_code: z.string(),
  client_order_code: z.string(),
  shop_id: z.number().int(),
  status: z.string(),
  updated_date: z.string(),
  cod_amount: z.number().int(),
  to_name: z.string().optional(),
  to_phone: z.string().optional(),
  to_address: z.string().optional(),
  to_district_id: z.number().int().optional(),
  to_ward_code: z.string().optional(),
});
export async function ghnCommandRequest(
  config: ShippingConfig,
  path: string,
  body: unknown,
) {
  const host =
    config.environment === 'staging'
      ? 'https://dev-online-gateway.ghn.vn'
      : 'https://online-gateway.ghn.vn';
  let response: Response;
  try {
    response = await fetch(host + '/shiip/public-api/' + path, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
      headers: {
        'Content-Type': 'application/json',
        Token: config.token,
        ShopId: String(config.shop_id),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ShippingError(
      'carrier_result_unknown',
      502,
      'Chưa rõ kết quả lệnh vận chuyển; cần tra cứu.',
    );
  }
  const raw = await readJson(
    new Request('https://internal.invalid', {
      method: 'POST',
      body: response.body,
      duplex: 'half',
    } as RequestInit),
    1_000_000,
  );
  const envelope = z
    .object({
      code: z.number(),
      data: z.unknown().optional(),
      code_message: z.string().optional(),
    })
    .safeParse(raw);
  if (!envelope.success)
    throw new ShippingError(
      'carrier_result_unknown',
      502,
      'Chưa xác minh được phản hồi hãng.',
    );
  if (envelope.data.code_message === 'OTP_NOT_VALID')
    throw new CarrierRejection(
      'carrier_awaiting_auth',
      409,
      'Hãng yêu cầu xác thực OTP qua tài khoản vận chuyển.',
    );
  if (!response.ok || envelope.data.code !== 200) {
    if (response.status >= 400 && response.status < 500)
      throw new CarrierRejection('carrier_rejected', 409, 'Hãng từ chối thao tác.');
    throw new ShippingError(
      'carrier_result_unknown',
      502,
      'Chưa rõ kết quả lệnh vận chuyển.',
    );
  }
  if (path.includes('switch-status/')) {
    const result = z
      .array(z.object({ order_code: z.string(), result: z.boolean() }))
      .length(1)
      .safeParse(envelope.data.data);
    if (
      !result.success ||
      result.data[0].order_code !== (body as { order_codes: string[] }).order_codes[0]
    )
      throw new ShippingError(
        'carrier_result_unknown',
        502,
        'Phản hồi thao tác không khớp vận đơn.',
      );
    if (!result.data[0].result)
      throw new CarrierRejection(
        'carrier_rejected',
        409,
        'Hãng không chấp nhận đổi trạng thái vận đơn.',
      );
  }
}
export async function ghnRecipientFields(
  config: ShippingConfig,
  recipient: z.infer<typeof checkoutInput>['recipient'],
) {
  const districts = z
    .array(
      z.object({
        DistrictID: z.number(),
        DistrictName: z.string(),
        ProvinceID: z.number(),
      }),
    )
    .parse(
      await ghnRequest(
        config,
        'master-data/district',
        { district_id: recipient.district_id },
        undefined,
        'GET',
      ),
    );
  const district = districts.find((d) => d.DistrictID === recipient.district_id);
  if (!district)
    throw new ShippingError(
      'carrier_address_unverified',
      409,
      'Không tìm thấy quận/huyện trên GHN.',
    );
  const [wards, provinces] = await Promise.all([
    ghnRequest(
      config,
      'master-data/ward',
      { district_id: recipient.district_id },
      undefined,
      'GET',
    ),
    ghnRequest(config, 'master-data/province', {}, undefined, 'GET'),
  ]);
  const ward = z
    .array(
      z.object({ WardCode: z.string(), WardName: z.string(), DistrictID: z.number() }),
    )
    .parse(wards)
    .find(
      (w) => w.WardCode === recipient.ward_code && w.DistrictID === district.DistrictID,
    );
  const province = z
    .array(z.object({ ProvinceID: z.number(), ProvinceName: z.string() }))
    .parse(provinces)
    .find((p) => p.ProvinceID === district.ProvinceID);
  if (!ward || !province)
    throw new ShippingError(
      'carrier_address_unverified',
      409,
      'Địa chỉ không khớp danh mục GHN.',
    );
  return {
    to_name: recipient.name,
    to_phone: recipient.phone,
    to_address: recipient.address,
    to_district_id: recipient.district_id,
    to_ward_code: recipient.ward_code,
    to_district_name: district.DistrictName,
    to_ward_name: ward.WardName,
    to_province_name: province.ProvinceName,
    is_new_to_address: false,
  };
}
export function ghnExecutionAdapter(config: ShippingConfig): ExecutionAdapter {
  return {
    async read(leg) {
      const raw = await ghnRequest(
        config,
        leg.tracking_code
          ? 'v2/shipping-order/detail'
          : 'v2/shipping-order/detail-by-client-code',
        leg.tracking_code
          ? { order_code: leg.tracking_code }
          : { client_order_code: leg.client_code },
        undefined,
        'GET',
      );
      const detail = detailSchema.parse(raw);
      if (
        detail.shop_id !== config.shop_id ||
        detail.client_order_code !== leg.client_code ||
        (leg.tracking_code && detail.order_code !== leg.tracking_code)
      )
        throw new ShippingError(
          'carrier_identity_mismatch',
          409,
          'Vận đơn không thuộc đúng tài khoản/tham chiếu.',
        );
      return observationSchema.parse({
        tracking_code: detail.order_code,
        client_code: detail.client_order_code,
        shop_id: detail.shop_id,
        status: detail.status,
        updated_at: Date.parse(detail.updated_date),
        cod_amount: detail.cod_amount,
        ...(detail.to_name &&
        detail.to_phone &&
        detail.to_address &&
        detail.to_district_id &&
        detail.to_ward_code
          ? {
              recipient: {
                name: detail.to_name,
                phone: detail.to_phone,
                address: detail.to_address,
                district_id: detail.to_district_id,
                ward_code: detail.to_ward_code,
              },
            }
          : {}),
      });
    },
    async prepare(leg, command, current) {
      const payload = JSON.parse(command.payload);
      if (command.kind === 'create') {
        const recipient = checkoutInput.shape.recipient.parse(payload.recipient);
        const parcel = z
          .object({
            weight_g: z.number().int().positive().max(50000),
            length_cm: z.number().int().positive().max(200),
            width_cm: z.number().int().positive().max(200),
            height_cm: z.number().int().positive().max(200),
            goods_value_vnd: z.number().int().nonnegative().max(5000000),
          })
          .parse(payload.parcel);
        const cod = z
          .number()
          .int()
          .nonnegative()
          .max(50000000)
          .parse(payload.cod_amount);
        const items = z
          .array(
            z.object({
              title: z.string().max(200),
              sku: z.string(),
              qty: z.number().int().positive(),
              weight_g: z.number().int().positive(),
            }),
          )
          .min(1)
          .parse(payload.items);
        if (
          !['2', '5'].includes(leg.service_id) ||
          (parcel.weight_g >= 20000 ? leg.service_id !== '5' : leg.service_id !== '2')
        )
          throw new ShippingError(
            'carrier_service_mismatch',
            409,
            'Dịch vụ không khớp trọng lượng kiện.',
          );
        return {
          path: 'v2/shipping-order/create',
          body: {
            ...(await ghnRecipientFields(config, recipient)),
            client_order_code: leg.client_code,
            service_type_id: Number(leg.service_id),
            payment_type_id: 1,
            required_note: 'CHOXEMHANGKHONGTHU',
            weight: parcel.weight_g,
            length: parcel.length_cm,
            width: parcel.width_cm,
            height: parcel.height_cm,
            insurance_value: parcel.goods_value_vnd,
            cod_amount: cod,
            items:
              leg.service_id === '5'
                ? [
                    {
                      name: 'Kiện trái cây và giỏ quà',
                      code: leg.client_code,
                      quantity: 1,
                      weight: parcel.weight_g,
                      length: parcel.length_cm,
                      width: parcel.width_cm,
                      height: parcel.height_cm,
                    },
                  ]
                : items.map((i) => ({
                    name: i.title,
                    code: i.sku,
                    quantity: i.qty,
                    weight: i.weight_g,
                  })),
            content: 'Trái cây và giỏ quà',
          },
        };
      }
      if (!current || !leg.tracking_code)
        throw new ShippingError('tracking_required', 409, 'Chưa xác nhận vận đơn.');
      if (command.kind === 'cod') {
        // Do not use the separate updateCOD API as an OTP bypass. Account owner
        // performs OTP at GHN; reconciliation verifies the intended amount.
        throw new CarrierRejection(
          'carrier_awaiting_auth',
          409,
          'Cần xác thực thay đổi COD tại GHN rồi tra cứu lại.',
        );
      }
      if (command.kind === 'address') {
        if (
          ![
            'ready_to_pick',
            'picking',
            'picked',
            'storing',
            'transporting',
            'sorting',
            'delivering',
            'delivery_fail',
            'waiting_to_return',
          ].includes(current.status)
        )
          throw new CarrierRejection(
            'carrier_state_rejected',
            409,
            'Trạng thái vận đơn không cho phép đổi địa chỉ.',
          );
        if (current.cod_amount !== payload.cod_amount)
          throw new CarrierRejection(
            'carrier_awaiting_auth',
            409,
            'Cần đối soát và xác thực COD trước khi đổi địa chỉ.',
          );
        return {
          path: 'v2/shipping-order/update',
          body: {
            order_code: leg.tracking_code,
            ...(await ghnRecipientFields(
              config,
              checkoutInput.shape.recipient.parse(payload.recipient),
            )),
          },
        };
      }
      const rule = {
        cancel: {
          states: ['ready_to_pick', 'picking', 'money_collect_picking'],
          path: 'cancel',
        },
        return: {
          states: ['delivery_fail', 'storing', 'waiting_to_return', 'return'],
          path: 'return',
        },
        redelivery: { states: ['storing', 'waiting_to_return'], path: 'storing' },
      }[command.kind as 'cancel' | 'return' | 'redelivery'];
      if (!rule || !rule.states.includes(current.status))
        throw new CarrierRejection(
          'carrier_state_rejected',
          409,
          'Hãng chưa hỗ trợ thao tác ở trạng thái này.',
        );
      return {
        path: 'v2/switch-status/' + rule.path,
        body: { order_codes: [leg.tracking_code] },
      };
    },
    async send(prepared) {
      await ghnCommandRequest(config, prepared.path, prepared.body);
    },
  };
}
export function commandSatisfied(command: Command, observation: CarrierObservation) {
  const payload = JSON.parse(command.payload);
  if (command.kind === 'create' || command.kind === 'reconcile') return true;
  if (command.kind === 'cancel') return observation.status === 'cancel';
  if (command.kind === 'return')
    return [
      'return',
      'return_transporting',
      'return_sorting',
      'returning',
      'return_fail',
      'returned',
    ].includes(observation.status);
  if (command.kind === 'redelivery')
    return [
      'transporting',
      'delivering',
      'money_collect_delivering',
      'delivered',
    ].includes(observation.status);
  if (command.kind === 'cod') return observation.cod_amount === payload.cod_amount;
  if (command.kind === 'address') {
    const actual = observation.recipient,
      expected = payload.recipient;
    const phone = (v: string) => v.replace(/^\+84/, '0').replace(/\s/g, '');
    return (
      !!actual &&
      actual.name === expected.name &&
      phone(actual.phone) === phone(expected.phone) &&
      actual.address === expected.address &&
      actual.district_id === expected.district_id &&
      actual.ward_code === expected.ward_code &&
      observation.cod_amount === payload.cod_amount
    );
  }
  return false;
}
