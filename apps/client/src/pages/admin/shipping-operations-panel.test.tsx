import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomUUID } from 'node:crypto';
const mockApi = { getJson: jest.fn(), postJson: jest.fn() };
jest.mock('@/authentication', () => ({ useSecuredApi: () => mockApi }));
jest.mock('@/lib/api-base', () => ({ getApiBase: () => '' }));
import ShippingOperationsPanel from './shipping-operations-panel';
const first = '00000000-0000-4000-8000-000000000001',
  second = '00000000-0000-4000-8000-000000000002';
let element: HTMLDivElement, root: Root;
const summary = (id: string, commands: unknown[] = []) => ({
  legs: [
    {
      id,
      kind: 'outbound',
      sequence: 1,
      client_code: 'HF' + id,
      carrier_id: 'ghn',
      owner: 'direct',
      tracking_code: null,
      status: 'unbooked',
      last_error: null,
      account_id: 'account',
      service_id: '2',
    },
  ],
  commands,
  conflicts: [],
});
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(crypto, 'randomUUID', { value: randomUUID, configurable: true });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  mockApi.postJson.mockResolvedValue({});
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
test('uncertain booking displays read-only reconciliation and retry never posts another create command', async () => {
  mockApi.getJson.mockResolvedValue(
    summary(first, [
      {
        id: second,
        leg_id: first,
        kind: 'create',
        state: 'unknown',
        result: 'carrier_result_unknown',
      },
    ]),
  );
  const changed = jest.fn(async () => {});
  await act(async () =>
    root.render(
      <ShippingOperationsPanel orderId={first} requests={[]} onChanged={changed} />,
    ),
  );
  expect(element.textContent).toContain('Chưa rõ kết quả — chỉ tra cứu');
  const retry = Array.from(element.querySelectorAll('button')).find(
    (b) => b.textContent === 'Kiểm tra lại lệnh',
  )!;
  await act(async () => retry.click());
  expect(mockApi.postJson).toHaveBeenCalledWith(
    `/v1/shipping-operations/commands/${second}/retry`,
    {},
  );
  expect(mockApi.postJson).toHaveBeenCalledTimes(1);
});
test('late responses for the previous order do not expose its commands on a newly opened order', async () => {
  let resolveOld!: (value: unknown) => void;
  mockApi.getJson.mockImplementation((url: string) =>
    url.endsWith(first)
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve(summary(second)),
  );
  const changed = async () => {};
  await act(async () =>
    root.render(
      <ShippingOperationsPanel orderId={first} requests={[]} onChanged={changed} />,
    ),
  );
  await act(async () =>
    root.render(
      <ShippingOperationsPanel orderId={second} requests={[]} onChanged={changed} />,
    ),
  );
  await act(async () => resolveOld(summary(first)));
  expect(element.textContent).toContain('HF' + second);
  expect(element.textContent).not.toContain('HF' + first);
  const create = Array.from(element.querySelectorAll('button')).find(
    (b) => b.textContent === 'Tạo vận đơn',
  )!;
  await act(async () => create.click());
  expect(mockApi.postJson.mock.calls[0][1]).toEqual(
    expect.objectContaining({ leg_id: second, kind: 'create' }),
  );
});
