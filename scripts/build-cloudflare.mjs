import { mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const assets = ['index.html', 'admin.html', 'create-account.html', 'styles.css', 'staff.css', 'visitor.js', 'admin.js', 'create-account.js'];

await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
for (const asset of assets) await copyFile(path.join(root, asset), path.join(publicDir, asset));
console.log(`Prepared ${assets.length} public DigiEntry assets for Cloudflare.`);
