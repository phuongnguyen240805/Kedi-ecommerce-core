const encode = new TextEncoder();
async function key(secret: string) {
  if (secret.length < 32)
    throw Error('ORDER_TOKEN_SECRET must contain at least 32 characters');
  return crypto.subtle.importKey(
    'raw',
    encode.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export async function commerceToken(id: string, secret: string) {
  const bytes = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    encode.encode('commerce-order:' + id),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function verifyCommerceToken(
  id: string,
  token: string,
  secret: string,
) {
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const bytes = Uint8Array.from(token.match(/../g)!, (b) => parseInt(b, 16));
  return crypto.subtle.verify(
    'HMAC',
    await key(secret),
    bytes,
    encode.encode('commerce-order:' + id),
  );
}
