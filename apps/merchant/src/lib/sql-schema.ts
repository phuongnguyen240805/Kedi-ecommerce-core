/** Avoid issuing DDL for existing objects on read-only requests. Free-tier
 * exhausted write quotas can reject DDL even when IF NOT EXISTS is a no-op. */
export function ensureSchemaObjects(sql:{exec:(query:string)=>{toArray:()=>Record<string,unknown>[]}},schema:string) {
  const existing=new Set(sql.exec("SELECT name FROM sqlite_master WHERE type IN ('table','index')").toArray().map(row=>String(row.name)));
  for(const statement of schema.split(';').map(s=>s.trim()).filter(Boolean)) {
    const object=statement.match(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_]\w*)/i);
    if(object&&existing.has(object[1]))continue;
    sql.exec(statement);
    if(object)existing.add(object[1]);
  }
}

/** Existing stores must be readable even when the daily write quota is spent. */
export function ensureStoreThemeDefaults(sql: {
  exec: (query: string, ...params: (string | number | null)[]) => { toArray: () => Record<string, unknown>[] };
}) {
  const defaults = [
    { id: 'theme_classic', name: 'Fufuni Classic', active: 1, config: { themeSlug: 'light', radius: 'md', accentOklch: 'oklch(87.41% 0.0128 244.59)' } },
    { id: 'theme_luxury', name: 'Luxury Minimal', active: 0, config: { themeSlug: 'luxury', radius: 'none', accentOklch: 'oklch(15% 0 0)' } },
  ];
  const existing = new Set(sql.exec('SELECT id FROM store_themes').toArray().map(row => String(row.id)));
  for (const theme of defaults) {
    if (existing.has(theme.id)) continue;
    sql.exec('INSERT OR IGNORE INTO store_themes (id, name, is_active, config_json) VALUES (?, ?, ?, ?)',
      theme.id, theme.name, theme.active, JSON.stringify(theme.config));
  }
}
