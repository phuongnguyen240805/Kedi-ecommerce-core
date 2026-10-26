import { readFile } from 'node:fs/promises';

// Credentials remain in environment variables, never CLI arguments or output.
const [command, orderId, proofFile] = process.argv.slice(2);
const methods = {
  exceptions: ['GET', '/admin/exceptions'],
  sync: ['POST', '/admin/orders/{id}/sync-pos'],
  bank: ['POST', '/admin/orders/{id}/bank_transfer'],
  collected: ['POST', '/admin/orders/{id}/cod_collected'],
  reconciled: ['POST', '/admin/orders/{id}/cod_reconciled'],
  fulfillment: ['POST', '/admin/orders/{id}/fulfillment'],
  cancel: ['POST', '/admin/orders/{id}/cancel'],
  resolve: ['POST', '/admin/orders/{id}/resolve-bank'],
};
if (!methods[command])
  throw Error(
    'Usage: node scripts/commerce-ops.mjs exceptions | sync ORDER_ID | bank|collected|reconciled|fulfillment|cancel|resolve ORDER_ID proof.json',
  );
const key = process.env.FUFUNI_ADMIN_KEY,
  origin = process.env.FUFUNI_BACKEND_URL;
if (!key || !origin)
  throw Error(
    'Set FUFUNI_ADMIN_KEY and FUFUNI_BACKEND_URL in your shell or ignored env file.',
  );
const base = new URL(origin);
if (
  base.protocol !== 'https:' &&
  !['localhost', '127.0.0.1'].includes(base.hostname)
)
  throw Error('Production backend must use HTTPS.');
if (base.username || base.password || base.search || base.hash)
  throw Error('Invalid backend origin.');
if (command !== 'exceptions' && !/^[a-f0-9-]{36}$/.test(orderId || ''))
  throw Error('A valid order UUID is required.');
const [method, path] = methods[command];
let body;
if (!['exceptions', 'sync'].includes(command)) {
  if (!proofFile) throw Error('A JSON evidence file is required.');
  const raw = await readFile(proofFile, 'utf8');
  if (Buffer.byteLength(raw) > 8192) throw Error('Evidence exceeds 8 KB.');
  body = JSON.parse(raw);
}
const url = new URL(
  base.pathname.replace(/\/$/, '') +
    '/v1/commerce' +
    path.replace('{id}', orderId),
  base.origin,
);
const response = await fetch(url, {
  method,
  redirect: 'error',
  signal: AbortSignal.timeout(30000),
  headers: {
    Authorization: 'Bearer ' + key,
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const data = await response.json();
if (!response.ok) {
  console.error(
    JSON.stringify({
      status: response.status,
      error: data.error?.code || 'request_failed',
    }),
  );
  process.exitCode = 1;
} else if (command === 'exceptions') console.log(JSON.stringify(data, null, 2));
else
  console.log(
    JSON.stringify({
      order_id: data.order_id || orderId,
      payment_status: data.payment_status,
      cod_status: data.cod_status,
      fulfillment_status: data.fulfillment_status,
      pos_sync_status: data.pos_sync_status,
      synced: data.synced,
    }),
  );
