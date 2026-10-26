import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const output = resolve('outputs/commerce-qa');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cartId = '00000000-0000-4000-8000-000000000001',
    orderId = '00000000-0000-4000-8000-000000000002';
  let selection = null,
    method = 'cod',
    confirmations = 0;
  const offer = {
    id: 'ghn:2',
    provider: 'ghn',
    service_type_id: 2,
    service_name: 'Giao tiêu chuẩn',
    currency: 'VND',
    carrier_fee_vnd: 30000,
    subsidy_vnd: 10000,
    customer_fee_vnd: 20000,
    cod_value_vnd: 220000,
    estimated_delivery_at: new Date(Date.now() + 3600000).toISOString(),
    source: 'carrier_api',
    environment: 'staging',
  };
  const order = {
    order_id: orderId,
    number: 'HFTESTORDER',
    order_status: 'pending',
    payment_method: 'techcombank_qr',
    payment_status: 'pending',
    cod_status: 'not_applicable',
    fulfillment_status: 'unfulfilled',
    currency: 'VND',
    total_vnd: 220000,
    amount_to_collect_vnd: 0,
    reference: 'HFTESTORDER',
    expires_at: Date.now() + 86400000,
    payment_expired: false,
    bank: { account_number: '50398838675', account_name: 'NGUYEN XUAN PHUONG' },
    qr_url:
      'https://img.vietqr.io/image/techcombank-50398838675-compact2.png?amount=220000&addInfo=HFTESTORDER',
    tracking_number: null,
    pos_sync_status: 'waiting_payment',
    totals: {
      subtotal_vnd: 200000,
      discount_vnd: 0,
      shipping_vnd: 20000,
      tax_vnd: 0,
      total_vnd: 220000,
    },
    items: [
      {
        sku: 'APPLE',
        title: 'Giỏ trái cây thử nghiệm',
        qty: 1,
        unit_price_vnd: 200000,
      },
    ],
    tracking_token: 'a'.repeat(64),
  };
  await page.addInitScript(
    ({ cartId }) => localStorage.setItem('halifruit_fufuni_cart_id', cartId),
    { cartId },
  );
  await page.route('https://img.vietqr.io/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="420"><rect width="320" height="420" fill="white"/><rect x="35" y="35" width="250" height="250" fill="#ecfdf5" stroke="#065f46"/><text x="160" y="170" text-anchor="middle" fill="#065f46">QR FIXTURE - TEST ONLY</text><text x="160" y="330" text-anchor="middle">Techcombank 220000 VND</text></svg>',
    }),
  );
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ json: {} }),
  );
  await page.route('**/api/trpc/**', async (route) => {
    const url = new URL(route.request().url()),
      names = url.pathname.split('/api/trpc/')[1].split(',');
    let raw =
      route.request().postData() || url.searchParams.get('input') || '{}';
    const inputs = JSON.parse(raw);
    const results = names.map((name, index) => {
      const input = inputs[index]?.json || {};
      let data = {};
      if (name === 'fufuni.getCart')
        data = {
          cart: {
            id: cartId,
            status: 'open',
            currency: 'VND',
            currency_code: 'vnd',
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            items: [
              {
                id: 'APPLE',
                sku: 'APPLE',
                title: 'Giỏ trái cây thử nghiệm',
                quantity: 1,
                unit_price: 200000,
                thumbnail: null,
              },
            ],
            total: selection ? 220000 : 200000,
            subtotal: 200000,
            shipping: {
              amount_cents: selection ? 20000 : 0,
              rate_id: null,
              rate_name: selection ? 'GHN' : null,
            },
            totals: {
              subtotal_cents: 200000,
              discount_cents: 0,
              shipping_cents: selection ? 20000 : 0,
              tax_cents: 0,
              total_cents: selection ? 220000 : 200000,
            },
          },
        };
      if (name === 'fufuni.getPaymentMethods')
        data = {
          enabled: true,
          methods: [
            { id: 'cod', label: 'Thanh toán khi nhận hàng', enabled: true },
            {
              id: 'techcombank_qr',
              label: 'Chuyển khoản QR Techcombank',
              enabled: true,
            },
          ],
          verification: 'manual_bank_statement',
        };
      if (name === 'fufuni.getShippingStatus')
        data = {
          enabled: true,
          ready: true,
          environment: 'staging',
          max_delivery_hours: 24,
        };
      if (name === 'fufuni.getShippingSelection') data = { selection };
      if (name === 'fufuni.saveCheckoutAddress') data = { saved: true };
      if (name === 'fufuni.getShippingLocations')
        data = {
          items: [
            {
              id:
                input.level === 'ward'
                  ? '0004'
                  : input.level === 'district'
                    ? '3'
                    : '1',
              name:
                input.level === 'ward'
                  ? 'Phường thử nghiệm'
                  : input.level === 'district'
                    ? 'Quận thử nghiệm'
                    : 'TP. Hồ Chí Minh',
            },
          ],
        };
      if (name === 'fufuni.getShippingQuotes') {
        method = input.payment_method;
        data = {
          quote: {
            id: '00000000-0000-4000-8000-000000000003',
            cart_id: cartId,
            fingerprint: 'test',
            expires_at: Date.now() + 300000,
            offers: [
              { ...offer, cod_value_vnd: method === 'cod' ? 220000 : 0 },
            ],
            recommended_id: 'ghn:2',
          },
          warnings: [],
          excluded_offers: [],
        };
      }
      if (name === 'fufuni.selectShippingQuote') {
        selection = {
          quote_id: input.quote_id,
          expires_at: Date.now() + 300000,
          destination: { district_id: 3, ward_code: '0004' },
          payment_method: method,
          offer: { ...offer, cod_value_vnd: method === 'cod' ? 220000 : 0 },
        };
        data = { selection };
      }
      if (name === 'fufuni.clearShippingSelection') {
        selection = null;
        data = { cleared: true };
      }
      if (name === 'fufuni.confirmCheckout') {
        confirmations++;
        assert.equal(input.payment_method, 'techcombank_qr');
        assert.equal(input.expected_total_vnd, 220000);
        data = order;
      }
      if (name === 'fufuni.trackOrder') data = order;
      if (
        name === 'fufuni.getRegions' ||
        name === 'fufuni.getCollections' ||
        name === 'fufuni.listCategories' ||
        name === 'fufuni.getProducts'
      )
        data = [];
      if (name === 'fufuni.getCollectionCatalog')
        data = { products: [], categories: [] };
      return { result: { data: { json: data } } };
    });
    await route.fulfill({
      json: url.searchParams.get('batch') === '1' ? results : results[0],
    });
  });
  await page.goto('http://localhost:3037/cart', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page
    .getByLabel('Họ tên người nhận')
    .fill('Test User', { timeout: 60000 });
  console.log('contact ready');
  await page.getByLabel('Số điện thoại', { exact: true }).fill('0901234567');
  await page
    .getByLabel('Số nhà, đường, phường/xã, quận/huyện')
    .fill('12 Test Street, Phường thử nghiệm');
  await page
    .getByLabel('Tỉnh / thành phố', { exact: true })
    .fill('TP. Hồ Chí Minh');
  await page.getByLabel('Email liên hệ').fill('qa@example.test');
  await page
    .getByLabel('Phương thức thanh toán')
    .selectOption('techcombank_qr');
  await page.getByRole('button', { name: 'Lưu địa chỉ và tiếp tục' }).click();
  console.log('address saved');
  const ship = page.locator('#smart-shipping');
  await ship.getByLabel('Tỉnh / thành phố').selectOption('1');
  await ship.getByLabel('Quận / huyện giao hàng').selectOption('3');
  await ship.getByLabel('Phường / xã').selectOption('0004');
  await ship.getByRole('button', { name: 'Tính phí và chọn rẻ nhất' }).click();
  console.log('quote requested');
  await page.getByRole('button', { name: 'Xác nhận đặt hàng' }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('#checkout button.bg-orange-600')?.disabled,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: resolve(output, 'checkout-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Xác nhận đặt hàng' }).click();
  console.log('order submitted');
  await page
    .getByRole('heading', { name: 'Đơn HFTESTORDER' })
    .waitFor({ timeout: 60000 });
  assert.equal(confirmations, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(output, 'tracking-mobile.png'),
    fullPage: true,
  });
  assert.ok(await page.getByText('50398838675', { exact: true }).isVisible());
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  console.log(
    JSON.stringify({
      checkout_and_tracking: 'passed',
      confirmation_requests: confirmations,
      page_errors: errors,
      screenshots: output,
    }),
  );
} finally {
  await browser.close();
}
