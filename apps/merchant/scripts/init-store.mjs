import { createHash, randomUUID } from 'node:crypto';

/** Idempotent provisioning. Credentials are read from the environment and never logged. */
export async function initializeStore({
  baseUrl,
  storeId,
  bootstrapToken,
  publicKey,
  adminKey,
  request = fetch,
}) {
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(storeId || '') ||
    !bootstrapToken ||
    !publicKey?.startsWith('pk_') ||
    !adminKey?.startsWith('sk_')
  )
    throw new Error(
      'STORE_ID, SETUP_INIT_TOKEN, MERCHANT_PK and MERCHANT_SK are required',
    );
  const base = new URL(baseUrl);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Invalid backend URL');
  const prefix = base.origin + `/stores/${storeId}`;
  async function api(path, token, body) {
    const response = await request(prefix + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok && !(path === '/v1/setup/init' && response.status === 409))
      throw new Error(`Store initialization failed: HTTP ${response.status}`);
    return response.json();
  }
  const keys = [
    { key: publicKey, role: 'public' },
    { key: adminKey, role: 'admin' },
  ].map(({ key, role }) => ({
    id: randomUUID(),
    key_hash: createHash('sha256').update(key).digest('hex'),
    key_prefix: key.slice(0, 8),
    role,
  }));
  await api('/v1/setup/init', bootstrapToken, { keys });
  const currencies = await api('/v1/regions/currencies', adminKey);
  let currency = currencies.items.find((item) => item.code === 'VND');
  if (!currency)
    currency = await api('/v1/regions/currencies', adminKey, {
      code: 'VND',
      display_name: 'Vietnamese Dong',
      symbol: '₫',
      decimal_places: 0,
    });
  if (currency.decimal_places !== 0 || currency.status !== 'active')
    throw new Error(
      'An active VND currency with zero decimal places is required',
    );
  const regions = await api('/v1/regions', adminKey);
  if (
    !regions.items.some(
      (item) => item.currency_id === currency.id && item.status === 'active',
    )
  )
    await api('/v1/regions', adminKey, {
      display_name: 'Việt Nam',
      currency_id: currency.id,
      is_default: !regions.items.some((item) => item.is_default),
    });
  return { store_id: storeId, currency: 'VND', ready: true };
}

if (
  process.argv[1] &&
  import.meta.url ===
    (await import('node:url')).pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        await initializeStore({
          baseUrl: process.env.FUFUNI_BACKEND_URL,
          storeId: process.env.STORE_ID,
          bootstrapToken: process.env.SETUP_INIT_TOKEN,
          publicKey: process.env.MERCHANT_PK,
          adminKey: process.env.MERCHANT_SK,
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
