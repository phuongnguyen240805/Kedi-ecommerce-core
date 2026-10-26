import type { ShippingSql } from './shipping-store';
import { ShippingError } from './smart-shipping';
/** Same synchronous tax calculation is used by shipping quotes and final checkout. */
export function cartTaxSummary(sql: ShippingSql, id: string) {
  const cart = sql
    .exec(
      'SELECT r.tax_inclusive FROM carts c LEFT JOIN regions r ON c.region_id=r.id WHERE c.id=?',
      id,
    )
    .toArray()[0];
  const inclusive = cart?.tax_inclusive === 1;
  const items = sql
    .exec(
      'SELECT ci.qty,ci.unit_price_cents,v.tax_code FROM cart_items ci JOIN variants v ON v.sku=ci.sku WHERE ci.cart_id=?',
      id,
    )
    .toArray();
  const rates = sql
    .exec(
      "SELECT * FROM tax_rates WHERE status='active' AND (country_code='VN' OR country_code IS NULL)",
    )
    .toArray();
  let tax = 0;
  for (const item of items) {
    const rate =
      rates.find(
        (r) => r.country_code === 'VN' && r.tax_code === item.tax_code,
      ) ||
      rates.find((r) => r.country_code === 'VN' && r.tax_code === null) ||
      rates.find(
        (r) => r.country_code === null && r.tax_code === item.tax_code,
      ) ||
      rates.find((r) => r.country_code === null && r.tax_code === null);
    const pct = Number(rate?.rate_percentage || 0);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100)
      throw new ShippingError(
        'tax_invalid',
        503,
        'Thuế chưa được cấu hình hợp lệ.',
      );
    const line = Number(item.qty) * Number(item.unit_price_cents);
    tax += Math.round(
      inclusive ? line - line / (1 + pct / 100) : (line * pct) / 100,
    );
  }
  return {
    tax_vnd: tax,
    tax_inclusive: inclusive,
    extra_vnd: inclusive ? 0 : tax,
  };
}
