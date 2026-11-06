import { mkdir, readdir, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || process.env.HALIFRUIT_PUBLIC_DIR || '');
if (!process.argv[2] && !process.env.HALIFRUIT_PUBLIC_DIR) throw new Error('Provide the Halifruit frontend public directory');
const store = process.argv[3] || 'halifruit';
if (!['halifruit', 'printerval'].includes(store)) throw new Error('Unsupported CDN store');
const assetDirectory = store === 'printerval' ? 'printerval-cdn-assets' : 'cdn-assets';
const destination = path.join(project, '.wrangler', assetDirectory);
// Only remove this fixed generated directory, never a caller-supplied path.
if (destination !== path.resolve(project, '.wrangler', assetDirectory) || source.startsWith(destination)) throw new Error('Invalid asset directory');
await readdir(source); // Verify the source exists before removing the previous snapshot.
await rm(destination, { recursive: true, force: true });
let count = 0;
async function copyImages(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = path.join(relative, entry.name);
    if (entry.isDirectory()) await copyImages(path.join(directory, entry.name), key);
    else if (entry.isFile() && /\.(png|jpe?g|webp|avif|gif|svg|ico)$/i.test(entry.name)) {
      await mkdir(path.dirname(path.join(destination, key)), { recursive: true });
      await copyFile(path.join(source, key), path.join(destination, key));
      count++;
    }
  }
}
await copyImages(source);
await mkdir(destination, { recursive: true });
await writeFile(path.join(destination, '_headers'), '/*\n  Cache-Control: public, max-age=3600\n  Access-Control-Allow-Origin: *\n  X-Content-Type-Options: nosniff\n');
console.log(`Prepared ${count} public images for the ${store} CDN (no R2).`);
