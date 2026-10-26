import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchemaObjects, ensureStoreThemeDefaults } from '../src/lib/sql-schema';

const schema = `CREATE TABLE IF NOT EXISTS store_themes (
  id TEXT PRIMARY KEY, name TEXT, is_active INTEGER, config_json TEXT
); CREATE INDEX IF NOT EXISTS theme_name ON store_themes(name);`;

test('an initialized store can boot with all writes rejected and preserves theme customization', () => {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...params: (string | number | null)[]) {
    const statement = db.prepare(query);
    if (statement.columns().length) return { toArray: () => statement.all(...params) };
    statement.run(...params); return { toArray: () => [] };
  } };
  ensureSchemaObjects(sql, schema);
  ensureStoreThemeDefaults(sql);
  db.prepare('UPDATE store_themes SET name=? WHERE id=?').run('Custom storefront', 'theme_classic');
  const readOnly = { exec(query: string, ...params: (string | number | null)[]) {
    assert.match(query, /^SELECT\b/i, 'startup attempted a write after the quota was exhausted');
    return sql.exec(query, ...params);
  } };
  ensureSchemaObjects(readOnly, schema);
  ensureStoreThemeDefaults(readOnly);
  assert.equal(db.prepare('SELECT name FROM store_themes WHERE id=?').get('theme_classic')?.name, 'Custom storefront');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM store_themes').get()?.count, 2);
  db.close();
});

test('a missing default is inserted without changing the existing default', () => {
  const db = new DatabaseSync(':memory:'); db.exec(schema);
  db.prepare('INSERT INTO store_themes VALUES (?, ?, ?, ?)').run('theme_classic', 'Custom storefront', 0, '{}');
  let writes = 0;
  const sql = { exec(query: string, ...params: (string | number | null)[]) {
    const statement = db.prepare(query);
    if (statement.columns().length) return { toArray: () => statement.all(...params) };
    writes++; statement.run(...params); return { toArray: () => [] };
  } };
  ensureStoreThemeDefaults(sql);
  assert.equal(writes, 1);
  assert.equal(db.prepare('SELECT name FROM store_themes WHERE id=?').get('theme_classic')?.name, 'Custom storefront');
  assert.equal(db.prepare('SELECT name FROM store_themes WHERE id=?').get('theme_luxury')?.name, 'Luxury Minimal');
  db.close();
});
