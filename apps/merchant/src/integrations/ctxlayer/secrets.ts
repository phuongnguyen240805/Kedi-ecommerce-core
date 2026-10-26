import { IntegrationError } from './config'
export function randomSecret() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}
export async function digest(value: string) {
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
    )
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}
async function key(value: string | undefined) {
  try {
    const bytes = Uint8Array.from(atob(value || ''), (c) => c.charCodeAt(0))
    if (bytes.length !== 32) throw Error()
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  } catch {
    throw new IntegrationError('mcp_encryption_configuration')
  }
}
export async function seal(secret: string | undefined, context: string, data: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(data))
  )
  return JSON.stringify({ v: 1, iv: Array.from(iv), data: Array.from(new Uint8Array(ciphertext)) })
}
export async function unseal(
  secret: string | undefined,
  context: string,
  value: string
): Promise<unknown> {
  try {
    const data = JSON.parse(value)
    if (data.v !== 1) throw Error()
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(data.iv),
        additionalData: new TextEncoder().encode(context)
      },
      await key(secret),
      new Uint8Array(data.data)
    )
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    throw new IntegrationError('mcp_secret_unavailable')
  }
}
