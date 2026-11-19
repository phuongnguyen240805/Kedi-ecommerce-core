import ShippingOperationsPanel, {
  ShippingWorkflowQueue,
} from './shipping-operations-panel';
import { useEffect, useRef, useState } from 'react';
import DefaultLayout from '@/layouts/default';
import { useSecuredApi } from '@/authentication';
import { getApiBase } from '@/lib/api-base';

type Row = {
  id: string;
  order_id: string;
  number: string;
  kind?: string;
  status: string;
  amount_vnd?: number;
  created_at: number;
};
type Request = {
  id: string;
  kind: string;
  status: string;
  payload: {
    reason: string;
    quote_id?: string;
    items?: { sku: string; qty: number }[];
    evidence_ids?: string[];
  };
  result: string | null;
  address_quote?: {
    recipient: { address: string; city: string };
    customer_fee_vnd: number;
    carrier_fee_vnd: number;
    expires_at: number;
  } | null;
};
type Detail = {
  shipping_automation?: boolean;
  order_version: number;
  recipient: { name: string; phone: string; address: string; city: string };
  requests: Request[];
  refunds: { id: string; amount_vnd: number; status: string; reason: string }[];
  money: { received_vnd: number; refunded_vnd: number; refundable_vnd: number };
  receipt: {
    number: string;
    order_status: string;
    reference: string;
    total_vnd: number;
    payment_status: string;
    cod_status: string;
    fulfillment_status: string;
    pos_sync_status: string;
    tracking_number: string | null;
  };
  audit: {
    action: string;
    actor: string;
    evidence: string;
    created_at: string;
  }[];
  transactions: {
    kind: string;
    amount_vnd: number;
    provider_transaction_id: string;
    received_at: string;
  }[];
};
const label: Record<string, string> = {
  cancel: 'Hủy đơn',
  address: 'Đổi địa chỉ',
  return: 'Đổi trả / hàng lỗi',
  pending: 'Chờ xử lý',
  approved: 'Đã duyệt',
  completed: 'Đã xử lý',
  rejected: 'Từ chối',
  processing: 'Đang thực hiện',
  unknown: 'Cần đối soát',
  failed: 'Thất bại',
  succeeded: 'Đã hoàn tiền',
};
const input =
  'mt-1 min-h-11 w-full rounded-xl border border-default-300 bg-background p-3';
const button =
  'min-h-11 rounded-xl border border-default-300 px-4 py-2 font-medium disabled:opacity-40';
const money = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);
export default function CommerceServicePage() {
  const { getJson, postJson } = useSecuredApi(),
    base = getApiBase();
  const [queue, setQueue] = useState<{ requests: Row[]; refunds: Row[] }>({
      requests: [],
      refunds: [],
    }),
    [exceptions, setExceptions] = useState<
      {
        order_id: string;
        number: string;
        payment_status: string;
        pos_sync_status: string;
      }[]
    >([]);
  const [orderId, setOrderId] = useState(''),
    [detail, setDetail] = useState<Detail | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [evidence, setEvidence] = useState(''),
    [publicMessage, setPublicMessage] = useState(''),
    [externalCleared, setExternalCleared] = useState(false),
    [absorb, setAbsorb] = useState(false);
  const [amount, setAmount] = useState(0),
    [reference, setReference] = useState(''),
    [transactionId, setTransactionId] = useState(''),
    [received, setReceived] = useState(''),
    [requestId, setRequestId] = useState('');
  const [resolution, setResolution] = useState('information'),
    [replacement, setReplacement] = useState(''),
    [lot, setLot] = useState(''),
    [disposition, setDisposition] = useState('quarantine'),
    [tracking, setTracking] = useState(''),
    [proofImage, setProofImage] = useState('');
  const currentId = useRef(''),
    refundKey = useRef(crypto.randomUUID());
  async function refresh() {
    const [q, e] = await Promise.all([
      getJson(`${base}/v1/commerce-service/admin/queue`),
      getJson(`${base}/v1/commerce/admin/exceptions`),
    ]);
    setQueue(q as typeof queue);
    setExceptions((e as { items: typeof exceptions }).items);
  }
  async function load(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Nhập mã định danh UUID của đơn.');
    const switched = currentId.current !== id;
    currentId.current = id;
    if (switched) {
      setEvidence('');
      setPublicMessage('');
      setAmount(0);
      setReference('');
      setTransactionId('');
      setReceived('');
      setAbsorb(false);
      setTracking('');
      setReplacement('');
      setLot('');
    }
    setDetail(null);
    setProofImage('');
    const d = (await getJson(`${base}/v1/commerce-service/admin/orders/${id}`)) as Detail;
    if (currentId.current === id) {
      setOrderId(id);
      setDetail(d);
      setExternalCleared(false);
      setRequestId('');
      refundKey.current = crypto.randomUUID();
    }
  }
  useEffect(() => {
    void refresh().catch((e) =>
      setMessage(e instanceof Error ? e.message : 'Chưa tải được hàng đợi.'),
    );
  }, []);
  async function run(task: () => Promise<unknown>, reload = true) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await task();
      setMessage('Đã ghi nhận thao tác. Kiểm tra trạng thái và lịch sử bên dưới.');
      if (reload && currentId.current) await load(currentId.current);
      if (reload) await refresh();
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : 'Thao tác chưa hoàn tất. Hãy tải lại và đối soát trước khi thử lại.',
      );
    } finally {
      setBusy(false);
    }
  }
  const service = (path: string, body: unknown) =>
    postJson(
      `${base}/v1/commerce-service/admin/orders/${currentId.current}/${path}`,
      body,
    );
  const operation = (path: string, body: unknown) =>
    postJson(`${base}/v1/commerce/admin/orders/${currentId.current}/${path}`, body);
  const validEvidence = evidence.trim().length >= 10;
  function decision(r: Request, action: 'approve' | 'reject' | 'complete') {
    if (!detail) return;
    return run(() =>
      service('decision', {
        order_version: detail.order_version,
        request_id: r.id,
        action,
        evidence,
        message: publicMessage || undefined,
        external_cleared: externalCleared,
        pricing: absorb ? 'shop_absorbs' : 'quoted',
        resolution: r.kind === 'return' ? resolution : undefined,
        replacement_reference: replacement || undefined,
        lot_reference: lot || undefined,
        disposition,
      }),
    );
  }
  return (
    <DefaultLayout>
      <section className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <h1 className="text-2xl font-semibold">Vận hành đơn hàng Halifruit</h1>
        <p>
          Tiền, giao hàng và yêu cầu khách được quản lý riêng. Chỉ xác nhận kết quả sau
          khi kiểm tra chứng từ. Hoàn tiền yêu cầu tài khoản kế toán được cấp quyền.
        </p>
        <p role="status" aria-live="polite" className="whitespace-pre-wrap break-words">
          {message}
        </p>
        <button className={button} disabled={busy} onClick={() => void run(refresh)}>
          Làm mới hàng đợi
        </button>
        <div className="grid gap-5 lg:grid-cols-2">
          {(['requests', 'refunds'] as const).map((k) => (
            <section key={k} className="rounded-2xl border border-default-200 p-5">
              <h2 className="mb-3 text-lg font-semibold">
                {k === 'requests' ? 'Yêu cầu cần xử lý' : 'Hoàn tiền đang xử lý'}
              </h2>
              {!queue[k].length && <p>Chưa có mục chờ xử lý.</p>}
              <ul className="space-y-2">
                {queue[k].map((r) => (
                  <li key={r.id}>
                    <button
                      className={`${button} w-full text-left`}
                      disabled={busy}
                      onClick={() => void run(() => load(r.order_id))}
                    >
                      {r.number} · {label[r.kind || r.status] || r.status}{' '}
                      {r.amount_vnd ? `· ${money(r.amount_vnd)}` : ''}
                      <span className="block text-sm">
                        {new Date(r.created_at).toLocaleString('vi-VN')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <details className="rounded-2xl border p-5">
          <summary className="cursor-pointer font-semibold">
            Ngoại lệ tiền / POS / COD ({exceptions.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {exceptions.map((r) => (
              <li key={r.order_id}>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void run(() => load(r.order_id))}
                >
                  {r.number} · {r.payment_status} · POS {r.pos_sync_status}
                </button>
              </li>
            ))}
          </ul>
        </details>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => load(orderId));
          }}
        >
          <label className="grow">
            Mã định danh đơn
            <input
              className={input}
              required
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
            />
          </label>
          <button className={button} disabled={busy}>
            Mở đơn
          </button>
        </form>
        <ShippingWorkflowQueue onSelect={(id) => void run(() => load(id), false)} />
        {detail && (
          <>
            <section className="space-y-3 rounded-2xl border p-5">
              <h2 className="text-xl font-semibold">{detail.receipt.number}</h2>
              <p>
                Đơn: {detail.receipt.order_status} · Tiền: {detail.receipt.payment_status}{' '}
                · COD: {detail.receipt.cod_status}
              </p>
              <p>
                Giao: {detail.receipt.fulfillment_status} · POS:{' '}
                {detail.receipt.pos_sync_status} · Vận đơn:{' '}
                {detail.receipt.tracking_number || 'Chưa có'}
              </p>
              <p>
                {detail.recipient.name} · {detail.recipient.phone}
                <br />
                {detail.recipient.address}, {detail.recipient.city}
              </p>
              <p>
                Tổng đơn: {money(detail.receipt.total_vnd)} · Thực nhận:{' '}
                {money(detail.money.received_vnd)} · Đã hoàn:{' '}
                {money(detail.money.refunded_vnd)} · Còn có thể lập hoàn:{' '}
                {money(detail.money.refundable_vnd)}
              </p>
            </section>
            <fieldset
              className="grid gap-4 rounded-2xl border p-5 sm:grid-cols-2"
              disabled={busy}
            >
              <legend className="font-semibold">Chứng từ cho thao tác</legend>
              <label className="sm:col-span-2">
                Ghi nhận nội bộ (tối thiểu 10 ký tự)
                <textarea
                  className={input}
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  maxLength={1000}
                />
              </label>
              <label className="sm:col-span-2">
                Phản hồi hiển thị cho khách
                <textarea
                  className={input}
                  value={publicMessage}
                  onChange={(e) => setPublicMessage(e.target.value)}
                  maxLength={500}
                />
              </label>
              {!detail.shipping_automation && (
                <label className="sm:col-span-2 flex items-start gap-2">
                  <input
                    type="checkbox"
                    disabled={detail.shipping_automation}
                    checked={externalCleared}
                    onChange={(e) => setExternalCleared(e.target.checked)}
                  />
                  Đã xác minh POS/vận đơn đã cập nhật hoặc ngừng xử lý; chứng từ nội bộ ở
                  trên ghi rõ kết quả. Với báo giá hết hạn, đã kiểm tra lại phương án hiện
                  hành với vận chuyển.
                </label>
              )}
              <label className="sm:col-span-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={absorb}
                  onChange={(e) => setAbsorb(e.target.checked)}
                />
                Shop chịu chênh lệch phí đổi địa chỉ và giữ nguyên tổng tiền khách (cần
                xác minh với vận chuyển nếu COD thay đổi).
              </label>
            </fieldset>
            <ShippingOperationsPanel
              orderId={orderId}
              requests={detail.requests}
              onChanged={() => load(orderId)}
            />
            <section className="space-y-4">
              <h2 className="text-xl font-semibold">Yêu cầu của khách</h2>
              <fieldset
                className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2"
                disabled={busy}
              >
                <legend>Phương án khi hoàn tất đổi trả</legend>
                <label>
                  Hướng xử lý
                  <select
                    className={input}
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  >
                    <option value="information">Tư vấn / thỏa thuận không thu hồi</option>
                    <option value="refund">Hoàn tiền (cần lập lệnh liên kết)</option>
                    <option value="replacement">Giao bù / thay thế</option>
                    <option value="return_inspection">Kiểm tra hàng thu hồi</option>
                  </select>
                </label>
                <label>
                  Mã đơn/vận đơn giao bù
                  <input
                    className={input}
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                  />
                </label>
                <label>
                  Mã lô / phiếu kiểm tra
                  <input
                    className={input}
                    value={lot}
                    onChange={(e) => setLot(e.target.value)}
                  />
                </label>
                <label>
                  Kết quả hàng thu hồi
                  <select
                    className={input}
                    value={disposition}
                    onChange={(e) => setDisposition(e.target.value)}
                  >
                    <option value="quarantine">Cách ly</option>
                    <option value="discard">Loại bỏ</option>
                    <option value="accepted">
                      Đạt kiểm tra (điều chỉnh kho qua POS riêng)
                    </option>
                  </select>
                </label>
              </fieldset>
              {detail.requests.map((r) => (
                <article key={r.id} className="space-y-3 rounded-2xl border p-5">
                  <h3 className="font-semibold">
                    {label[r.kind]} · {label[r.status]}
                  </h3>
                  <p>{r.payload.reason}</p>
                  {r.address_quote && (
                    <p>
                      Địa chỉ mới: {r.address_quote.recipient.address},{' '}
                      {r.address_quote.recipient.city} · Phí khách:{' '}
                      {money(r.address_quote.customer_fee_vnd)} · Phí hãng:{' '}
                      {money(r.address_quote.carrier_fee_vnd)} · Hạn báo giá:{' '}
                      {new Date(r.address_quote.expires_at).toLocaleString('vi-VN')}
                    </p>
                  )}
                  {r.payload.items?.map((i) => (
                    <p key={i.sku}>
                      {i.sku} × {i.qty}
                    </p>
                  ))}
                  {r.payload.evidence_ids?.map((id) => (
                    <button
                      key={id}
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const image = (await service('evidence', {
                            evidence_id: id,
                          })) as { mime: string; base64: string };
                          setProofImage(`data:${image.mime};base64,${image.base64}`);
                        }, false)
                      }
                    >
                      Xem ảnh chứng cứ
                    </button>
                  ))}
                  <div className="flex flex-wrap gap-3">
                    {r.status === 'pending' && (
                      <button
                        className={button}
                        disabled={busy || !validEvidence}
                        onClick={() => void decision(r, 'approve')}
                      >
                        Duyệt yêu cầu
                      </button>
                    )}
                    {['pending', 'approved'].includes(r.status) && (
                      <button
                        className={button}
                        disabled={busy || !validEvidence}
                        onClick={() => void decision(r, 'reject')}
                      >
                        Từ chối yêu cầu
                      </button>
                    )}
                    {r.status === 'approved' &&
                      !(
                        detail.shipping_automation &&
                        ['cancel', 'address'].includes(r.kind)
                      ) && (
                        <button
                          className={button}
                          disabled={busy || !validEvidence}
                          onClick={() => void decision(r, 'complete')}
                        >
                          Xác nhận đã xử lý
                        </button>
                      )}
                  </div>
                </article>
              ))}
            </section>
            {proofImage && (
              <div>
                <img
                  src={proofImage}
                  alt="Ảnh chứng cứ của đơn"
                  className="max-h-96 max-w-full rounded-xl"
                />
                <button className={button} onClick={() => setProofImage('')}>
                  Đóng ảnh
                </button>
              </div>
            )}
            <section className="space-y-4 rounded-2xl border p-5">
              <h2 className="text-xl font-semibold">Thu tiền và đối soát COD</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <label>
                  Số tiền VND
                  <input
                    className={input}
                    type="number"
                    min={1}
                    max={2000000000}
                    value={amount || ''}
                    onChange={(e) => setAmount(Number(e.target.value))}
                  />
                </label>
                <label>
                  Mã giao dịch / chứng từ
                  <input
                    className={input}
                    value={transactionId}
                    onChange={(e) => setTransactionId(e.target.value)}
                  />
                </label>
                <label>
                  Thời điểm thực nhận
                  <input
                    className={input}
                    type="datetime-local"
                    value={received}
                    onChange={(e) => setReceived(e.target.value)}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-3">
                {[
                  ['bank_transfer', 'Ghi nhận chuyển khoản'],
                  ['cod_collected', 'Xác nhận thu COD'],
                  ['cod_reconciled', 'Đối soát COD'],
                ].map(([kind, title]) => (
                  <button
                    key={kind}
                    className={button}
                    disabled={
                      busy ||
                      !validEvidence ||
                      amount <= 0 ||
                      transactionId.length < 3 ||
                      !received
                    }
                    onClick={() =>
                      void run(() =>
                        operation(kind, {
                          transaction_id: transactionId,
                          reference: detail.receipt.reference,
                          amount_vnd: amount,
                          currency: 'VND',
                          received_at: new Date(received).toISOString(),
                          evidence,
                        }),
                      )
                    }
                  >
                    {title}
                  </button>
                ))}
              </div>
              <label className="block">
                Yêu cầu đổi địa chỉ đã duyệt
                <select
                  className={input}
                  value={requestId}
                  onChange={(e) => setRequestId(e.target.value)}
                >
                  <option value="">Chọn yêu cầu</option>
                  {detail.requests
                    .filter((r) => r.kind === 'address' && r.status === 'approved')
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className={button}
                disabled={
                  busy ||
                  !validEvidence ||
                  !requestId ||
                  amount <= 0 ||
                  !received ||
                  transactionId.length < 3
                }
                onClick={() =>
                  void run(() =>
                    service('adjustment-payment', {
                      request_id: requestId,
                      order_version: detail.order_version,
                      transaction_id: transactionId,
                      amount_vnd: amount,
                      evidence,
                      received_at: new Date(received).toISOString(),
                    }),
                  )
                }
              >
                Ghi nhận chuyển khoản bổ sung phí
              </button>
              <button
                className={button}
                disabled={busy || evidence.trim().length < 20}
                onClick={() =>
                  void run(() =>
                    service('reconcile', {
                      order_version: detail.order_version,
                      evidence,
                    }),
                  )
                }
              >
                Xác nhận đối soát thu / hoàn theo sổ tiền
              </button>
              <p className="text-sm">
                Sai lệch chuyển khoản được đưa vào hàng đợi ngoại lệ. Không ghi nhận chứng
                từ giả để ép đơn sang đã thanh toán.
              </p>
            </section>
            <section className="space-y-4 rounded-2xl border p-5">
              <h2 className="text-xl font-semibold">Lập và xác nhận hoàn tiền</h2>
              <label className="block">
                Yêu cầu liên quan
                <select
                  className={input}
                  value={requestId}
                  onChange={(e) => setRequestId(e.target.value)}
                >
                  <option value="">Khoản hoàn độc lập / sai lệch tiền</option>
                  {detail.requests
                    .filter((r) => ['approved', 'completed'].includes(r.status))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {label[r.kind]} · {r.id}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className={button}
                disabled={
                  busy ||
                  !validEvidence ||
                  amount <= 0 ||
                  amount > detail.money.refundable_vnd
                }
                onClick={() =>
                  void run(async () => {
                    await service('refunds', {
                      idempotency_key: refundKey.current,
                      order_version: detail.order_version,
                      amount_vnd: amount,
                      reason: evidence,
                      request_id: requestId || undefined,
                    });
                    refundKey.current = crypto.randomUUID();
                  })
                }
              >
                Lập lệnh hoàn {money(amount)}
              </button>
              <label className="block">
                Mã giao dịch hoàn tiền
                <input
                  className={input}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
              <p className="text-sm">
                Người xác nhận hoàn thành phải khác người tạo lệnh; cần chứng từ ngân hàng
                thực tế. Kết quả chưa rõ phải chọn đối soát.
              </p>
              {detail.refunds.map((r) => (
                <article key={r.id} className="space-y-2 rounded-xl border p-4">
                  <p>
                    {money(r.amount_vnd)} · {label[r.status]} · {r.reason}
                  </p>
                  {!['failed', 'succeeded'].includes(r.status) && (
                    <div className="flex flex-wrap gap-2">
                      {(['processing', 'unknown', 'failed', 'succeeded'] as const).map(
                        (status) => (
                          <button
                            key={status}
                            className={button}
                            disabled={
                              busy ||
                              !validEvidence ||
                              (status === 'succeeded' && reference.length < 3)
                            }
                            onClick={() =>
                              void run(() =>
                                service('refund-result', {
                                  order_version: detail.order_version,
                                  refund_id: r.id,
                                  status,
                                  reference: reference || undefined,
                                  evidence,
                                }),
                              )
                            }
                          >
                            {label[status]}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </article>
              ))}
            </section>
            <section className="space-y-4 rounded-2xl border p-5">
              <h2 className="text-xl font-semibold">Giao hàng</h2>
              <label className="block">
                Mã vận đơn
                <input
                  className={input}
                  value={tracking}
                  onChange={(e) => setTracking(e.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  ['ready_to_ship', 'Chờ lấy hàng'],
                  ['shipped', 'Đã bàn giao'],
                  ['delivered', 'Đã giao'],
                  ['returned', 'Đã hoàn về'],
                ].map(([state, title]) => (
                  <button
                    key={state}
                    className={button}
                    disabled={busy || !validEvidence}
                    onClick={() =>
                      void run(() =>
                        operation('fulfillment', {
                          state,
                          tracking_number: tracking || undefined,
                          evidence,
                        }),
                      )
                    }
                  >
                    {title}
                  </button>
                ))}
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void run(() => operation('sync-pos', {}))}
                >
                  Đồng bộ / kiểm tra POS
                </button>
              </div>
            </section>
            <details className="rounded-2xl border p-5">
              <summary className="cursor-pointer font-semibold">
                Lịch sử nội bộ và chứng từ
              </summary>
              {detail.audit.map((a, i) => (
                <article key={i} className="mt-3 border-t py-3">
                  <p>
                    {a.created_at} · {a.action} · {a.actor}
                  </p>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-sm">
                    {a.evidence}
                  </pre>
                </article>
              ))}
            </details>
          </>
        )}
      </section>
    </DefaultLayout>
  );
}
