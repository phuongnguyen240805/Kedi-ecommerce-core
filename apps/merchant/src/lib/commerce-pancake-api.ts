import { z } from 'zod';
import type { Env } from '../types';
import { ShippingError } from './smart-shipping';
import { readJson } from './read-json';

export const pancakeOrderSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  custom_id: z.string().nullish(),
  total_price: z.number().int(),
  money_to_collect: z.number().int(),
  cod: z.number().int().nonnegative(),
  prepaid: z.number().int().nonnegative(),
}).passthrough();

export function pancakeReference(order: z.infer<typeof pancakeOrderSchema>) {
  return order.custom_id || String(order.id);
}

export function assertPancakeMoney(pos: z.infer<typeof pancakeOrderSchema>, order: { reference: string; total_vnd: number; amount_to_collect_vnd: number }) {
  if (pancakeReference(pos) !== order.reference || pos.money_to_collect !== order.total_vnd || pos.cod !== order.amount_to_collect_vnd || pos.prepaid !== order.total_vnd - order.amount_to_collect_vnd)
    throw new ShippingError('pos_money_mismatch', 409, 'Tham chiếu, tổng tiền hoặc số COD của Pancake không khớp.');
}

export async function pancakeRequest(env: Env, path: string, body?: unknown, method?: 'POST' | 'PUT', geo = false) {
  if (!env.PANCAKE_API_KEY || !env.PANCAKE_SHOP_ID)
    throw new ShippingError('pos_not_configured', 503, 'Chưa cấu hình Pancake cho shop.');
  const url = new URL('https://pos.pages.fm/api/v1' + (geo ? '' : '/shops/' + encodeURIComponent(env.PANCAKE_SHOP_ID)) + path);
  url.searchParams.set('api_key', env.PANCAKE_API_KEY);
  const res = await fetch(url, {
    // Workers supports manual/follow only. Never follow a redirect carrying the API key.
    method: body === undefined ? 'GET' : method || 'POST', redirect: 'manual',
    signal: AbortSignal.timeout(12000),
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ShippingError('pos_unavailable', 502, 'Pancake không xác nhận yêu cầu.');
  }
  const raw = await readJson(new Request('https://internal.invalid', {
    method: 'POST', body: res.body, duplex: 'half',
  } as RequestInit), 1_000_000);
  if (raw && typeof raw === 'object' && 'success' in raw && raw.success === false)
    throw new ShippingError('pos_rejected', 502, 'Pancake từ chối thao tác.');
  return raw;
}

export function parsePancakeOrder(raw: unknown) {
  const wrapped = z.object({ data: pancakeOrderSchema }).safeParse(raw);
  return wrapped.success ? wrapped.data.data : pancakeOrderSchema.parse(raw);
}
