import type { ShippingSql } from './shipping-store';

export const progressStages = ['placed', 'confirmed', 'pickup', 'shipping', 'delivered'] as const;
export type ProgressStage = typeof progressStages[number];
export type ProgressException = 'canceled' | 'delivery_failed' | 'returning' | 'returned' | 'partial_return';
export type ProgressObservation = { pos_status?: number; carrier_status?: string; tracking_number?: string };

// POS codes: https://docs.pancake.biz/pos/st-f13/st-p3?lang=vi
export function resolveProgress(input: ProgressObservation, previous: ProgressStage = 'placed') {
  const pos = input.pos_status, carrier = input.carrier_status;
  let exception: ProgressException | null = null;
  if (pos === 6 || pos === 7) exception = 'canceled';
  else if (pos === 5 || ['returned', 'returned_cod'].includes(carrier || '')) exception = 'returned';
  else if (pos === 15) exception = 'partial_return';
  else if (pos === 4 || ['waiting_for_return', 'returning'].includes(carrier || '')) exception = 'returning';
  else if (['undeliverable', 'delay_delivery', 'canceled'].includes(carrier || '')) exception = 'delivery_failed';
  let rank = progressStages.indexOf(previous);
  if (pos !== undefined && [1, 8, 11, 12, 13, 20].includes(pos)) rank = Math.max(rank, 1);
  if (pos === 9 || input.tracking_number) rank = Math.max(rank, 2);
  if (pos === 2 || ['picked_up', 'waiting_on_the_way', 'on_the_way', 'contact_delivery_company', 'out_for_delivery', 'delay_delivery', 'inform_recipient', 'undeliverable'].includes(carrier || '')) rank = Math.max(rank, 3);
  if (!exception && (pos === 3 || pos === 16 || ['delivered', 'delivered_cod'].includes(carrier || ''))) rank = 4;
  return { stage: progressStages[rank], exception };
}

type Event = { stage: ProgressStage; exception: ProgressException | null; at: string };
export function readOrderProgress(sql: ShippingSql, id: string, fallback: { fulfillment_status: string; status: string; tracking_number: unknown; created_at: unknown }) {
  const rows = sql.exec("SELECT evidence,created_at FROM commerce_audit WHERE order_id=? AND action='tracking.observed' ORDER BY created_at DESC,rowid DESC LIMIT 100", id).toArray();
  const events = rows.reverse().flatMap(row => {
    try {
      const data = JSON.parse(String(row.evidence));
      if (!progressStages.includes(data.stage)) return [];
      return [{ stage: data.stage, exception: data.exception || null, at: String(row.created_at) } as Event];
    } catch { return []; }
  });
  const latest = events[events.length - 1];
  const stage: ProgressStage = fallback.fulfillment_status === 'delivered' ? 'delivered'
    : fallback.fulfillment_status === 'shipped' ? 'shipping'
    : fallback.fulfillment_status === 'ready_to_ship' || fallback.tracking_number ? 'pickup' : 'placed';
  const current = latest ? { ...latest, stage: progressStages.indexOf(stage) > progressStages.indexOf(latest.stage) ? stage : latest.stage } : { stage, exception: null };
  const timestamps: Partial<Record<ProgressStage, string>> = { placed: String(fallback.created_at) };
  for (const event of events) timestamps[event.stage] ||= event.at;
  return {
    stage: current.stage,
    exception: fallback.status === 'canceled' ? 'canceled' as const : fallback.fulfillment_status === 'returned' ? 'returned' as const : current.exception,
    timestamps,
    history: events.slice(-20).reverse(),
  };
}

export function observeOrderProgress(sql: ShippingSql, id: string, input: ProgressObservation, now: number) {
  const row = sql.exec('SELECT o.status,o.created_at,o.tracking_number,c.fulfillment_status FROM orders o JOIN commerce_orders c ON c.order_id=o.id WHERE o.id=?', id).toArray()[0];
  if (!row) return;
  const previous = readOrderProgress(sql, id, row as Parameters<typeof readOrderProgress>[2]);
  const current = resolveProgress(input, previous.stage);
  // Keep the last confirmed exception until an explicit POS/carrier observation clears it.
  if (input.pos_status === undefined && input.carrier_status === undefined) return;
  if (current.stage === previous.stage && current.exception === previous.exception) return;
  sql.exec('INSERT INTO commerce_audit(id,order_id,action,actor,evidence,created_at) VALUES(?,?,?,?,?,?)',
    crypto.randomUUID(), id, 'tracking.observed', 'pancake', JSON.stringify(current), new Date(now).toISOString());
}
