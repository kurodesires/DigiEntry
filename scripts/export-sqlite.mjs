import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve(process.env.DATA_DIR || 'data', 'digientry.sqlite');
const output = path.resolve('data/d1-import.sql');
const db = new DatabaseSync(source, { readOnly: true });
const quote = value => value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const insert = (table, columns, rows) => rows.map(row => `INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(column => quote(row[column])).join(',')});`).join('\n');

const staff = db.prepare('SELECT id,name,rank,password_hash,created_at FROM staff').all();
const requests = db.prepare('SELECT id,reference,name,phone,email,reason,status,qr_token_hash,created_at,decided_at,decided_by,checked_in_at,checked_in_by FROM requests').all();
db.close();
const sql = [
  'PRAGMA foreign_keys=ON;',
  insert('staff', ['id','name','rank','password_hash','created_at'], staff),
  insert('requests', ['id','reference','name','phone','email','reason','status','qr_token_hash','created_at','decided_at','decided_by','checked_in_at','checked_in_by'], requests)
].filter(Boolean).join('\n\n');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${sql}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`Exported ${staff.length} staff accounts and ${requests.length} visitor requests to ${output}. No session tokens were exported.`);
