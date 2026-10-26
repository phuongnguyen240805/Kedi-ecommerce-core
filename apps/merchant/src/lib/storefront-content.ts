export const STOREFRONT_CONTENT_SCHEMA = `CREATE TABLE IF NOT EXISTS storefront_content (
  kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(kind,id)
);`;
