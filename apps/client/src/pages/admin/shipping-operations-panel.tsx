import { useEffect, useRef, useState } from 'react';
import { useSecuredApi } from '@/authentication';
import { getApiBase } from '@/lib/api-base';

type Summary = {
  legs: {
    id: string;
    kind: string;
    sequence: number;
    request_id: string | null;
    client_code: string;
    carrier_id: string;
    owner: string;
    tracking_code: string | null;
    status: string;
    last_error: string | null;
    account_id: string;
    service_id: string;
  }[];
  commands: {
    id: string;
    leg_id: string;
    kind: string;
    state: string;
    result: string | null;
  }[];
  conflicts: { id: string; code: string; details: string }[];
};
const labels: Record<string, string> = {
  outbound: 'Giao hàng',
  reverse: 'Thu hồi',
  replacement: 'Giao bù',
  pending: 'Chờ thực hiện',
  running: 'Đang thực hiện',
  unknown: 'Chưa rõ kết quả — chỉ tra cứu',
  verified: 'Đã xác minh',
  manual_review: 'Cần nhân viên xử lý',
  awaiting_auth: 'Cần xác thực tại hãng',
  rejected: 'Hãng/chính sách từ chối',
  create: 'Tạo vận đơn',
  cancel: 'Hủy vận đơn',
  address: 'Đổi địa chỉ',
  cod: 'Đối soát COD',
  return: 'Yêu cầu chuyển hoàn',
  redelivery: 'Yêu cầu giao lại',
  reconcile: 'Tra cứu và đối soát',
  unbooked: 'Chưa xác nhận vận đơn',
  ready_to_pick: 'Chờ lấy hàng',
  picking: 'Đang lấy hàng',
  picked: 'Đã lấy hàng',
  transporting: 'Đang vận chuyển',
  delivering: 'Đang giao',
  delivered: 'Đã giao',
  returned: 'Đã hoàn',
  cancelled: 'Đã hủy',
};
const button =
  'min-h-11 rounded-xl border border-default-300 px-4 py-2 disabled:opacity-40';
export default function ShippingOperationsPanel({
  orderId,
  requests,
  onChanged,
}: {
  orderId: string;
  requests: { id: string; kind: string; status: string }[];
  onChanged: () => Promise<void>;
}) {
  const api = useSecuredApi(),
    apiRef = useRef(api);
  apiRef.current = api;
  const [summary, setSummary] = useState<Summary | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const current = useRef(orderId);
  current.current = orderId;
  async function load(id = orderId) {
    const value = (await apiRef.current.getJson(
      `${getApiBase()}/v1/shipping-operations/orders/${id}`,
    )) as Summary;
    if (current.current === id && Array.isArray(value.legs)) setSummary(value);
  }
  useEffect(() => {
    let active = true;
    setSummary(null);
    setMessage('');
    void load().catch(() => {
      if (active) setMessage('Chưa tải được trạng thái vận chuyển.');
    });
    const timer = setInterval(() => void load().catch(() => {}), 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [orderId]);
  async function run(task: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await task();
      await load();
      await onChanged();
      setMessage('Đã ghi nhận. Hệ thống sẽ tra cứu và hiển thị kết quả xác minh.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Chưa thực hiện được thao tác.');
    } finally {
      setBusy(false);
    }
  }
  function command(legId: string, kind: string, requestId?: string) {
    return run(() =>
      apiRef.current.postJson(`${getApiBase()}/v1/shipping-operations/commands`, {
        idempotency_key: crypto.randomUUID(),
        leg_id: legId,
        kind,
        request_id: requestId,
      }),
    );
  }
  function prepare(kind: 'reverse' | 'replacement', requestId: string) {
    const outbound = summary?.legs.find((l) => l.kind === 'outbound');
    if (!outbound) return;
    return run(() =>
      apiRef.current.postJson(`${getApiBase()}/v1/shipping-operations/legs`, {
        idempotency_key: crypto.randomUUID(),
        order_id: orderId,
        request_id: requestId,
        kind,
        account_id: outbound.account_id,
        service_id: outbound.service_id,
      }),
    );
  }
  return (
    <section
      className="space-y-4 rounded-2xl border p-5"
      aria-label="Điều phối vận chuyển"
    >
      <h2 className="text-xl font-semibold">Điều phối vận chuyển</h2>
      <p>
        Lệnh chưa rõ kết quả chỉ được tra cứu; xác nhận giao hàng không xác nhận thu COD
        hay hoàn tiền.
      </p>
      <p role="status">{message}</p>
      {summary?.legs.map((leg) => (
        <article key={leg.id} className="space-y-3 rounded-xl border p-4">
          <h3 className="font-semibold">
            {labels[leg.kind] || leg.kind} {leg.sequence} · {leg.carrier_id.toUpperCase()}
          </h3>
          <p className="break-words">
            {labels[leg.status] || leg.status} ·{' '}
            {leg.tracking_code || 'Chưa có mã vận đơn'}
          </p>
          <p className="break-all text-sm">
            Mã tham chiếu: {leg.client_code} · Thực thi: {leg.owner}
          </p>
          {leg.last_error && (
            <p className="break-words text-warning-700">Cần xử lý: {leg.last_error}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              disabled={busy}
              onClick={() => void command(leg.id, 'reconcile')}
            >
              Tra cứu lại
            </button>
            {leg.kind === 'outbound' && leg.owner === 'direct' && (
              <>
                {!leg.tracking_code && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void command(leg.id, 'create')}
                  >
                    Tạo vận đơn
                  </button>
                )}
                {requests
                  .filter(
                    (r) =>
                      r.status === 'approved' && ['cancel', 'address'].includes(r.kind),
                  )
                  .map((r) => (
                    <button
                      key={r.id}
                      className={button}
                      disabled={busy}
                      onClick={() => void command(leg.id, r.kind, r.id)}
                    >
                      {r.kind === 'cancel'
                        ? 'Thực thi hủy đã duyệt'
                        : 'Thực thi đổi địa chỉ đã duyệt'}
                    </button>
                  ))}
                {leg.tracking_code && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void command(leg.id, 'redelivery')}
                  >
                    Yêu cầu giao lại
                  </button>
                )}
              </>
            )}
          </div>
          {leg.kind !== 'outbound' && !leg.tracking_code && (
            <p>
              Đặt chặng thu hồi/giao bù với nhà vận chuyển bằng mã tham chiếu trên, sau đó
              tra cứu để xác minh. Kiểm tra hàng và tồn kho được xử lý riêng.
            </p>
          )}
        </article>
      ))}
      {requests
        .filter((r) => r.kind === 'return' && r.status === 'approved')
        .map((r) => (
          <div className="flex flex-wrap gap-2" key={r.id}>
            <button
              className={button}
              disabled={busy}
              onClick={() => void prepare('reverse', r.id)}
            >
              Chuẩn bị chặng thu hồi
            </button>
            <button
              className={button}
              disabled={busy}
              onClick={() => void prepare('replacement', r.id)}
            >
              Chuẩn bị chặng giao bù
            </button>
          </div>
        ))}
      {summary?.commands.map((c) => (
        <div key={c.id} className="rounded-xl bg-default-50 p-3">
          <p>
            {labels[c.kind] || c.kind} · {labels[c.state] || c.state}
          </p>
          {c.state !== 'verified' && <p className="break-words text-sm">{c.result}</p>}
          {['unknown', 'manual_review', 'awaiting_auth', 'rejected'].includes(
            c.state,
          ) && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void run(() =>
                  apiRef.current.postJson(
                    `${getApiBase()}/v1/shipping-operations/commands/${c.id}/retry`,
                    {},
                  ),
                )
              }
            >
              Kiểm tra lại lệnh
            </button>
          )}
        </div>
      ))}
      {!!summary?.conflicts.length && (
        <details>
          <summary className="cursor-pointer py-2">
            Ngoại lệ cần đối soát ({summary.conflicts.length})
          </summary>
          {summary.conflicts.map((c) => (
            <p key={c.id} className="break-words py-2">
              {c.code} · {c.details}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}

export function ShippingWorkflowQueue({ onSelect }: { onSelect: (id: string) => void }) {
  const api = useSecuredApi(),
    ref = useRef(api);
  ref.current = api;
  const [data, setData] = useState<{
    items: { order_id: string; number: string; kind: string; state: string }[];
    legs: { order_id: string; number: string; last_error: string }[];
    unmatched: number;
  } | null>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const value = (await ref.current.getJson(
          getApiBase() + '/v1/shipping-operations/queue',
        )) as typeof data;
        if (active && Array.isArray(value?.items)) setData(value);
      } catch {
        /* Older backend can still serve the customer request queue. */
      }
    }
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  if (!data || (!data.items.length && !data.legs.length && !data.unmatched)) return null;
  const rows = [
    ...data.items,
    ...data.legs.map((l) => ({ ...l, kind: 'reconcile', state: 'manual_review' })),
  ].filter((r, i, a) => a.findIndex((x) => x.order_id === r.order_id) === i);
  return (
    <section className="space-y-3 rounded-2xl border p-5">
      <h2 className="text-xl font-semibold">Vận chuyển cần xử lý</h2>
      {rows.map((r) => (
        <button
          key={r.order_id}
          className={button + ' block text-left'}
          onClick={() => onSelect(r.order_id)}
        >
          {r.number} · {labels[r.kind] || r.kind} · {labels[r.state] || r.state}
        </button>
      ))}
      {!!data.unmatched && (
        <p>
          {data.unmatched} thông báo chưa liên kết được với vận đơn; cần đối soát cấu hình
          tài khoản/mã tham chiếu.
        </p>
      )}
    </section>
  );
}
