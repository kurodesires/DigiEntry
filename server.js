const crypto = require('node:crypto');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const app = express();
const port = Number(process.env.PORT || 3000);
const root = __dirname;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'digientry.sqlite'));
db.exec(`PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, name TEXT NOT NULL, rank TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', qr_token_hash TEXT UNIQUE, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT REFERENCES staff(id), checked_in_at TEXT, checked_in_by TEXT REFERENCES staff(id));
  CREATE UNIQUE INDEX IF NOT EXISTS staff_name_unique ON staff(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS requests_status_created ON requests(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS requests_history ON requests(status, decided_at DESC);`);

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const scrypt = promisify(crypto.scrypt);
async function passwordHash(password) { const salt=crypto.randomBytes(16).toString('hex'); const derived=await scrypt(password,salt,64); return `scrypt$${salt}$${derived.toString('hex')}`; }
async function passwordMatches(password,stored) { const [,salt,expected]=String(stored).split('$'); if(!salt||!expected)return false; const derived=await scrypt(password,salt,64); const expectedBuffer=Buffer.from(expected,'hex'); return expectedBuffer.length===derived.length&&crypto.timingSafeEqual(derived,expectedBuffer); }
const newToken = () => crypto.randomBytes(32).toString('base64url');
const nowIso = () => new Date().toISOString();
const ranks = new Set(['Principal', 'Vice Principal', 'Teacher']);
const STAFF_SHARED_PASSWORD = 'ACTSTAFF';
const mailReady = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM);
const mailer = mailReady ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;
const emailValid = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const publicRequest = row => ({ id: row.id, reference: row.reference, name: row.name, phone: row.phone, email: row.email, reason: row.reason, status: row.status, createdAt: row.created_at, decidedAt: row.decided_at, checkedInAt: row.checked_in_at });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

function sessionStaff(req, res, next) {
  const token = req.cookies?.digientry;
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  const row = db.prepare(`SELECT staff.id, staff.name, staff.rank FROM sessions JOIN staff ON staff.id=sessions.staff_id WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(hash(token), Date.now());
  if (!row) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  req.staff = row;
  next();
}
function cookieParser(req, res, next) {
  req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split(/=(.*)/s)).filter(pair => pair.length > 1).map(([k,v]) => [k, decodeURIComponent(v)]));
  next();
}
app.use(cookieParser);
function requireScannerKey(req, res, next) {
  if (!process.env.SCANNER_API_KEY) return res.status(503).json({ valid: false, decision: 'unavailable', message: 'Scanner integration is not configured.' });
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.get('x-scanner-key') || '';
  const a = Buffer.from(supplied), b = Buffer.from(process.env.SCANNER_API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ valid: false, decision: 'unauthorized', message: 'Invalid scanner credentials.' });
  next();
}
async function sendDecisionEmail(row, qrToken) {
  if (!mailer) throw new Error('Email delivery is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM.');
  const accepted = row.status === 'accepted';
  const qr = await QRCode.toBuffer(qrToken, { type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M' });
  const subject = `${accepted ? 'Visit approved' : 'Visit request update'} · DigiEntry · ${row.reference}`;
  const heading = accepted ? 'Your visit is approved' : 'Your visit request was declined';
  const instructions = accepted ? 'Please show the attached QR pass to the campus scanner when you arrive.' : 'Your pass records this decision. You may submit a new request with another reason for entering campus.';
  await mailer.sendMail({
    from: process.env.MAIL_FROM,
    to: row.email,
    subject,
    text: `Hello ${row.name},\n\n${heading}.\nReference: ${row.reference}\nReason: ${row.reason}\n\n${instructions}\n\nAsian College of Technology · Bulacao Campus`,
    html: `<div style="font-family:Arial,sans-serif;color:#18253b;max-width:560px;margin:auto"><div style="background:#101c35;color:white;padding:24px;border-radius:14px 14px 0 0"><strong style="font-size:18px">DigiEntry</strong><div style="font-size:11px;margin-top:8px;color:#ced7e8">ASIAN COLLEGE OF TECHNOLOGY · BULACAO CAMPUS</div></div><div style="padding:25px;border:1px solid #e7eaf0;border-top:0;border-radius:0 0 14px 14px"><h1 style="font-size:22px">${heading}</h1><p>Hello ${escapeHtml(row.name)},</p><p>${escapeHtml(instructions)}</p><p><b>Request:</b> ${escapeHtml(row.reference)}<br><b>Reason:</b> ${escapeHtml(row.reason)}</p><p style="text-align:center"><img alt="QR visit pass" src="cid:visitor-pass" width="240" height="240"></p><p style="font-size:12px;color:#738097">Keep this email available when you arrive. The QR pass reflects your request decision.</p></div></div>`,
    attachments: [{ filename: `digientry-${row.reference}.png`, content: qr, contentType: 'image/png', cid: 'visitor-pass' }]
  });
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]); }

app.get('/api/health', (req,res) => res.json({ ok: true, emailConfigured: mailReady, initialAdminConfigured: Boolean(process.env.INITIAL_ADMIN_KEY), scannerConfigured: Boolean(process.env.SCANNER_API_KEY) }));
app.post('/api/auth/login', async (req,res) => {
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  if (!name || !password) return res.status(400).json({ error: 'Enter your full name and password.' });
  const staff = db.prepare('SELECT * FROM staff WHERE name=? COLLATE NOCASE').get(name);
  if (!staff || password.toUpperCase() !== STAFF_SHARED_PASSWORD) return res.status(401).json({ error: 'Name or password is incorrect.' });
  const token = newToken();
  db.prepare('INSERT INTO sessions(token_hash,staff_id,expires_at) VALUES(?,?,?)').run(hash(token), staff.id, Date.now() + 8 * 60 * 60 * 1000);
  res.setHeader('Set-Cookie', `digientry=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ staff: { name: staff.name, rank: staff.rank } });
});
app.post('/api/auth/register', async (req,res) => {
  if (String(req.body?.password || '').toUpperCase() !== STAFF_SHARED_PASSWORD) return res.status(403).json({ error: 'Enter the campus staff password ACTSTAFF.' });
  return createStaff(req,res);
});
async function createStaff(req,res) {
  const name=String(req.body?.name||'').trim(), rank=String(req.body?.rank||''), password=String(req.body?.password||'');
  if (name.length<2 || name.length>120 || !ranks.has(rank) || password.toUpperCase() !== STAFF_SHARED_PASSWORD) return res.status(400).json({ error: 'Enter a name, a valid campus rank and the staff password ACTSTAFF.' });
  try {
    const id=crypto.randomUUID();
    db.prepare('INSERT INTO staff(id,name,rank,password_hash,created_at) VALUES(?,?,?,?,?)').run(id,name,rank,await passwordHash(STAFF_SHARED_PASSWORD),nowIso());
    res.status(201).json({ message:'Staff account created.' });
  } catch { res.status(409).json({ error:'An account with that name already exists.' }); }
}
app.post('/api/auth/logout', (req,res) => { const token=req.cookies?.digientry; if(token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); res.setHeader('Set-Cookie','digientry=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ok:true}); });
app.get('/api/auth/me',sessionStaff,(req,res)=>res.json({staff:req.staff}));
app.get('/api/requests',sessionStaff,(req,res)=>{
  const requests=db.prepare(`SELECT * FROM requests ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`).all();
  res.json({requests:requests.map(publicRequest),counts:{pending:requests.filter(r=>r.status==='pending').length,accepted:requests.filter(r=>r.status==='accepted').length,checkedIn:requests.filter(r=>r.status==='checked_in').length}});
});
app.post('/api/requests',(req,res)=>{
  const name=String(req.body?.name||'').trim(),phone=String(req.body?.phone||'').trim(),email=String(req.body?.email||'').trim().toLowerCase(),reason=String(req.body?.reason||'').trim();
  if(name.length<2||name.length>120||phone.length<7||phone.length>30||!emailValid(email)||email.length>254||reason.length<5||reason.length>500) return res.status(400).json({error:'Please provide a valid name, contact number, email and visit reason.'});
  const id=crypto.randomUUID(),reference=crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare('INSERT INTO requests(id,reference,name,phone,email,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,reference,name,phone,email,reason,'pending',nowIso());
  res.status(201).json({reference,message:'Your request has been sent to campus administrators.'});
});
app.post('/api/requests/:id/decision',sessionStaff,async(req,res)=>{
  const status=req.body?.status;
  if(!['accepted','declined'].includes(status)) return res.status(400).json({error:'Decision must be accepted or declined.'});
  const row=db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if(!row) return res.status(404).json({error:'Request not found.'});
  if(row.status!=='pending') return res.status(409).json({error:'This request has already been reviewed.'});
  if(!mailer) return res.status(503).json({error:'Email is not configured. Set the SMTP settings before making a decision so the visitor receives the required email and QR pass.'});
  const token=newToken();
  db.prepare('UPDATE requests SET status=?,qr_token_hash=?,decided_at=?,decided_by=? WHERE id=? AND status=?').run(status,hash(token),nowIso(),req.staff.id,row.id,'pending');
  const updated=db.prepare('SELECT * FROM requests WHERE id=?').get(row.id);
  try { await sendDecisionEmail(updated,token); }
  catch(err) {
    db.prepare('UPDATE requests SET status="pending",qr_token_hash=NULL,decided_at=NULL,decided_by=NULL WHERE id=?').run(row.id);
    console.error('Decision email failed:',err.message);
    return res.status(502).json({error:'Email could not be sent. The request remains pending; check the email settings and try again.'});
  }
  res.json({request:publicRequest(updated),emailSent:true});
});
function verifyPass(req,res){
  const token=String(req.body?.token||'');
  if(token.length<32||token.length>200) return res.status(400).json({valid:false,decision:'invalid',message:'QR pass is invalid.'});
  const row=db.prepare('SELECT * FROM requests WHERE qr_token_hash=?').get(hash(token));
  if(!row) return res.status(200).json({valid:false,decision:'invalid',message:'QR pass is invalid.'});
  if(row.status==='declined') return res.json({valid:false,decision:'declined',message:'Your form is declined, you may give another reason to enter.',reference:row.reference});
  if(row.status==='checked_in') return res.json({valid:false,decision:'already_used',message:'This pass has already been used.',reference:row.reference});
  if(row.status!=='accepted') return res.json({valid:false,decision:'pending',message:'This visit has not been approved.',reference:row.reference});
  const checked=db.prepare('UPDATE requests SET status="checked_in",checked_in_at=?,checked_in_by=? WHERE id=? AND status="accepted"').run(nowIso(),req.staff?.id||null,row.id);
  if(!checked.changes) return res.json({valid:false,decision:'already_used',message:'This pass has already been used.',reference:row.reference});
  res.json({valid:true,decision:'accepted',message:'You may enter the campus.',reference:row.reference,name:row.name});
}
app.post('/api/scanner/verify',requireScannerKey,verifyPass);
app.post('/api/staff/scanner/verify',sessionStaff,verifyPass);
app.get('/',(req,res)=>res.sendFile(path.join(root,'index.html')));
app.get(['/index.html','/admin.html','/create-account.html','/styles.css','/staff.css','/visitor.js','/admin.js','/create-account.js'],(req,res)=>res.sendFile(path.join(root,path.basename(req.path))));
app.use((req,res)=>res.status(404).json({error:'Not found.'}));
app.listen(port,()=>console.log(`DigiEntry listening on http://localhost:${port}`));
