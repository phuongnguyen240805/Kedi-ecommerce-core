export type ImageCdnConfig = {
  IMAGE_CDN_URL?: string;
  IMAGE_CDN_ALLOWED_HOSTS?: string;
};

// Exact hostnames only. Never accept arbitrary origins or wildcard subdomains.
export function allowedImageSource(value: string, hosts = ''): URL | null {
  try {
    const url = new URL(value);
    const allowed = hosts.split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.hash || !allowed.includes(url.hostname)) return null;
    return url;
  } catch { return null; }
}

export function cdnImageUrl(value: string, config: ImageCdnConfig): string {
  if (!config.IMAGE_CDN_URL) return value;
  const source = allowedImageSource(value, config.IMAGE_CDN_ALLOWED_HOSTS);
  if (!source) return value;
  const target = new URL('/remote', config.IMAGE_CDN_URL);
  target.searchParams.set('url', source.href);
  return target.href;
}

// Rewrite responses, not stored data: changing CDN domains requires no migration.
export function rewriteImageFields(value: unknown, config: ImageCdnConfig): unknown {
  if (Array.isArray(value)) return value.map(item => rewriteImageFields(item, config));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['image_url', 'thumbnail_url'].includes(key) && typeof item === 'string'
      ? cdnImageUrl(item, config) : rewriteImageFields(item, config),
  ]));
}
