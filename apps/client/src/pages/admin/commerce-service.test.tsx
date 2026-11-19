import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomUUID } from 'node:crypto';
const mockApi = { getJson: jest.fn(), postJson: jest.fn() };
jest.mock('@/authentication', () => ({ useSecuredApi: () => mockApi }));
jest.mock('@/lib/api-base', () => ({ getApiBase: () => '' }));
jest.mock('@/layouts/default', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
import CommerceServicePage from './commerce-service';
const original = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002';
let container: HTMLDivElement, root: Root;
beforeEach(async () => {
  Object.defineProperty(crypto, 'randomUUID', {
    value: randomUUID,
    configurable: true,
  });
  jest.clearAllMocks();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const detail = {
    order_version: 1,
    recipient: {
      name: 'QA',
      phone: '0901234567',
      address: '12 Test Street',
      city: 'HCM',
    },
    requests: [
      {
        id: original,
        kind: 'cancel',
        status: 'pending',
        payload: { reason: 'Khách muốn hủy đơn trước khi chuẩn bị.' },
        result: null,
      },
    ],
    refunds: [],
    money: { received_vnd: 220000, refunded_vnd: 0, refundable_vnd: 220000 },
    receipt: {
      number: 'HF-ADMIN-1',
      order_status: 'paid',
      reference: 'HF-ADMIN-1',
      total_vnd: 220000,
      payment_status: 'paid',
      cod_status: 'not_applicable',
      fulfillment_status: 'unfulfilled',
      pos_sync_status: 'pending',
      tracking_number: null,
    },
    audit: [],
    transactions: [],
  };
  mockApi.getJson.mockImplementation(async (url: string) =>
    url.endsWith('/queue')
      ? {
          requests: [
            {
              id: original,
              order_id: original,
              number: 'HF-ADMIN-1',
              kind: 'cancel',
              status: 'pending',
              created_at: Date.now(),
            },
          ],
          refunds: [],
        }
      : url.endsWith('/exceptions')
        ? { items: [] }
        : JSON.parse(JSON.stringify(detail)),
  );
  mockApi.postJson.mockResolvedValue({});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<CommerceServicePage />));
  await act(async () => {
    (container.querySelector('ul button') as HTMLButtonElement).click();
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function setValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el),
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function button(text: string) {
  const b = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.startsWith(text),
  );
  expect(b).toBeDefined();
  return b as HTMLButtonElement;
}
test('operations require evidence and target the loaded order, not an edited lookup field', async () => {
  expect(button('Duyệt yêu cầu').disabled).toBe(true);
  await setValue(container.querySelector('form input')!, other);
  await setValue(
    container.querySelector('textarea')!,
    'Đã kiểm tra điều kiện hủy với shop.',
  );
  await act(async () => button('Duyệt yêu cầu').click());
  expect(mockApi.postJson).toHaveBeenCalledWith(
    `/v1/commerce-service/admin/orders/${original}/decision`,
    expect.objectContaining({
      request_id: original,
      order_version: 1,
      action: 'approve',
    }),
  );
});
test('uncertain refund submission retries the same idempotency key', async () => {
  await setValue(
    container.querySelector('textarea')!,
    'Đã duyệt hoàn tiền cho khách hàng.',
  );
  await setValue(container.querySelector('input[type="number"]')!, '100000');
  mockApi.postJson.mockRejectedValue(
    new Error('Mất kết nối sau khi gửi lệnh.'),
  );
  await act(async () => button('Lập lệnh hoàn').click());
  await act(async () => button('Lập lệnh hoàn').click());
  expect(mockApi.postJson).toHaveBeenCalledTimes(2);
  expect(mockApi.postJson.mock.calls[0][1].idempotency_key).toBe(
    mockApi.postJson.mock.calls[1][1].idempotency_key,
  );
});
