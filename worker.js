import QRCode from 'qrcode';
import { connect } from 'cloudflare:sockets';

const STAFF_PASSWORD = 'ACTSTAFF';
const RANKS = new Set(['Principal', 'Vice Principal', 'Teacher']);
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const bytes = length => crypto.getRandomValues(new Uint8Array(length));
const hex = data => [...data].map(value => value.toString(16).padStart(2, '0')).join('');
const token = () => {
  const data = bytes(32);
  let binary = '';
  for (const value of data) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const emailValid = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const publicRequest = row => ({ id: row.id, reference: row.reference, name: row.name, phone: row.phone, email: row.email, reason: row.reason, status: row.status, createdAt: row.created_at, decidedAt: row.decided_at, checkedInAt: row.checked_in_at });
const parseBody = async request => {
  try { return await request.json(); } catch { return null; }
};
const getCookie = (request, name) => {
  const match = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  try { return match ? decodeURIComponent(match[1]) : ''; } catch { return ''; }
};
const secureHeaders = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' };

async function staffFor(request, env) {
  const raw = getCookie(request, 'digientry');
  if (!raw) return null;
  return env.DB.prepare(`SELECT staff.id, staff.name, staff.rank FROM sessions JOIN staff ON staff.id=sessions.staff_id WHERE sessions.token_hash=? AND sessions.expires_at>?`)
    .bind(await digest(raw), Date.now()).first();
}

function base64Bytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function smtpCommand(write, readReply, command, expected) {
  await write(command);
  const response = await readReply();
  if (!expected.includes(response.code)) throw new Error(`SMTP ${command.split(' ')[0]} failed (${response.code}).`);
  return response;
}

async function emailDecision(row, qrToken, env) {
  if (!env.SMTP_USER || !env.SMTP_PASS || !env.MAIL_FROM) throw new Error('Email is not configured. Add SMTP_USER, SMTP_PASS and MAIL_FROM in Cloudflare Worker settings.');
  const accepted = row.status === 'accepted';
  const heading = accepted ? 'Your visit is approved' : 'Your visit request was declined';
  const instructions = accepted ? 'Please show the attached QR pass to the campus scanner when you arrive.' : 'Your pass records this decision. You may submit a new request with another reason for entering campus.';
  const qrDataUrl = await QRCode.toDataURL(qrToken, { width: 360, margin: 2, errorCorrectionLevel: 'M' });
  const qrBase64 = qrDataUrl.slice(qrDataUrl.indexOf(',') + 1);
  const text = `Hello ${row.name},\n\n${heading}.\nReference: ${row.reference}\nReason: ${row.reason}\n\n${instructions}\n\nAsian College of Technology · Bulacao Campus`;
  const html = `<div style="font-family:Arial,sans-serif;color:#18253b;max-width:560px;margin:auto"><div style="background:#101c35;color:white;padding:24px;border-radius:14px 14px 0 0"><strong style="font-size:18px">DigiEntry</strong><div style="font-size:11px;margin-top:8px;color:#ced7e8">ASIAN COLLEGE OF TECHNOLOGY · BULACAO CAMPUS</div></div><div style="padding:25px;border:1px solid #e7eaf0;border-top:0;border-radius:0 0 14px 14px"><h1 style="font-size:22px">${heading}</h1><p>Hello ${escapeHtml(row.name)},</p><p>${escapeHtml(instructions)}</p><p><b>Request:</b> ${escapeHtml(row.reference)}<br><b>Reason:</b> ${escapeHtml(row.reason)}</p><p>The QR visit pass is attached to this email.</p><p style="font-size:12px;color:#738097">Keep this email available when you arrive. The QR pass reflects your request decision.</p></div></div>`;
  const host = env.SMTP_HOST || 'smtp.gmail.com';
  const socket = connect({ hostname: host, port: Number(env.SMTP_PORT || 465) }, { secureTransport: 'on' });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const readReply = async () => {
    const lines = [];
    let code = 0;
    while (true) {
      let boundary = pending.indexOf('\r\n');
      while (boundary < 0) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SMTP connection closed unexpectedly.');
        pending += decoder.decode(chunk.value, { stream: true });
        boundary = pending.indexOf('\r\n');
      }
      const line = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      lines.push(line);
      const match = line.match(/^(\d{3})([ -])/);
      if (match) {
        code = Number(match[1]);
        if (match[2] === ' ') break;
      }
    }
    return { code, lines };
  };
  const write = async value => writer.write(encoder.encode(`${value}\r\n`));
  const expect = async (command, expected) => smtpCommand(write, readReply, command, expected);
  try {
    let greeting = await readReply();
    if (greeting.code !== 220) throw new Error(`SMTP greeting failed (${greeting.code}).`);
    await expect('EHLO digientry', [250]);
    const credentials = base64Bytes(encoder.encode(`\0${env.SMTP_USER}\0${env.SMTP_PASS}`));
    await expect(`AUTH PLAIN ${credentials}`, [235]);
    const fromAddress = env.MAIL_FROM.match(/<([^>]+)>/)?.[1] || env.MAIL_FROM;
    await expect(`MAIL FROM:<${fromAddress}>`, [250]);
    await expect(`RCPT TO:<${row.email}>`, [250, 251]);
    await expect('DATA', [354]);
    const boundary = `DigiEntry_${hex(bytes(12))}`;
    const subject = `${accepted ? 'Visit approved' : 'Visit request update'} | DigiEntry | ${row.reference}`;
    const htmlPart = base64Bytes(encoder.encode(html)).match(/.{1,76}/g)?.join('\r\n') || '';
    const textPart = base64Bytes(encoder.encode(text)).match(/.{1,76}/g)?.join('\r\n') || '';
    const attachmentLines = qrBase64.match(/.{1,76}/g)?.join('\r\n') || '';
    let message = [
      `From: ${env.MAIL_FROM}`,
      `To: ${row.email}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: multipart/alternative; boundary="alt_digientry"',
      '',
      '--alt_digientry',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      textPart,
      '--alt_digientry',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      htmlPart,
      '--alt_digientry--',
      `--${boundary}`,
      `Content-Type: image/png; name="digientry-${row.reference}.png"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="digientry-${row.reference}.png"`,
      '',
      attachmentLines,
      `--${boundary}--`,
      '.'
    ].join('\r\n');
    message = message.replace(/(^|\r\n)\./g, '$1..');
    await writer.write(encoder.encode(`${message}\r\n`));
    const sent = await readReply();
    if (sent.code !== 250) throw new Error(`SMTP message was rejected (${sent.code}).`);
    await write('QUIT');
    await readReply();
  } finally {
    try { await writer.close(); } catch { /* close can follow a remote SMTP disconnect */ }
    try { reader.releaseLock(); } catch { /* reader may already be closed */ }
    try { writer.releaseLock(); } catch { /* writer may already be closed */ }
    try { await socket.close(); } catch { /* socket may already be closed */ }
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;
  const body = method === 'POST' ? await parseBody(request) : null;
  if (method === 'POST' && body === null) return json({ error: 'Invalid request body.' }, 400);

  if (method === 'GET' && path === '/api/health') return json({ ok: true, emailConfigured: Boolean(env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM), scannerConfigured: Boolean(env.SCANNER_API_KEY) });

  if (method === 'POST' && path === '/api/auth/login') {
    const name = String(body?.name || '').trim(), password = String(body?.password || '');
    if (!name || !password) return json({ error: 'Enter your full name and password.' }, 400);
    const staff = await env.DB.prepare('SELECT id,name,rank FROM staff WHERE lower(name)=lower(?)').bind(name).first();
    if (!staff || password.toUpperCase() !== STAFF_PASSWORD) return json({ error: 'Name or password is incorrect.' }, 401);
    const raw = token();
    await env.DB.prepare('INSERT INTO sessions(token_hash,staff_id,expires_at) VALUES(?,?,?)').bind(await digest(raw), staff.id, Date.now() + 8 * 60 * 60 * 1000).run();
    return json({ staff: { name: staff.name, rank: staff.rank } }, 200, { 'Set-Cookie': `digientry=${encodeURIComponent(raw)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800` });
  }

  if (method === 'POST' && path === '/api/auth/register') {
    const name = String(body?.name || '').trim(), rank = String(body?.rank || ''), password = String(body?.password || '');
    if (password.toUpperCase() !== STAFF_PASSWORD) return json({ error: 'The staff password is incorrect.' }, 403);
    if (name.length < 2 || name.length > 120 || !RANKS.has(rank)) return json({ error: 'Enter your full name and select a valid campus rank.' }, 400);
    try {
      await env.DB.prepare('INSERT INTO staff(id,name,rank,password_hash,created_at) VALUES(?,?,?,?,?)').bind(uuid(), name, rank, 'shared-staff-password', now()).run();
      return json({ message: 'Staff account created.' }, 201);
    } catch {
      return json({ error: 'An account with that name already exists.' }, 409);
    }
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const raw = getCookie(request, 'digientry');
    if (raw) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(raw)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'digientry=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
  }

  if (method === 'GET' && path === '/api/auth/me') {
    const staff = await staffFor(request, env);
    return staff ? json({ staff }) : json({ error: 'Please sign in.' }, 401);
  }

  if (method === 'GET' && path === '/api/requests') {
    const staff = await staffFor(request, env);
    if (!staff) return json({ error: 'Please sign in.' }, 401);
    const result = await env.DB.prepare(`SELECT * FROM requests ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`).all();
    const rows = result.results || [];
    return json({ requests: rows.map(publicRequest), counts: { pending: rows.filter(row => row.status === 'pending').length, accepted: rows.filter(row => row.status === 'accepted').length, checkedIn: rows.filter(row => row.status === 'checked_in').length } });
  }

  if (method === 'POST' && path === '/api/requests') {
    const name = String(body?.name || '').trim(), phone = String(body?.phone || '').trim(), email = String(body?.email || '').trim().toLowerCase(), reason = String(body?.reason || '').trim();
    if (name.length < 2 || name.length > 120 || phone.length < 7 || phone.length > 30 || !emailValid(email) || email.length > 254 || reason.length < 5 || reason.length > 500) return json({ error: 'Please provide a valid name, contact number, email and visit reason.' }, 400);
    const id = uuid(), reference = hex(bytes(4)).toUpperCase();
    await env.DB.prepare('INSERT INTO requests(id,reference,name,phone,email,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, reference, name, phone, email, reason, 'pending', now()).run();
    return json({ reference, message: 'Your request has been sent to campus administrators.' }, 201);
  }

  const decisionMatch = path.match(/^\/api\/requests\/([^/]+)\/decision$/);
  if (method === 'POST' && decisionMatch) {
    const staff = await staffFor(request, env);
    if (!staff) return json({ error: 'Please sign in.' }, 401);
    const status = body?.status;
    if (!['accepted', 'declined'].includes(status)) return json({ error: 'Decision must be accepted or declined.' }, 400);
    const id = decodeURIComponent(decisionMatch[1]);
    const row = await env.DB.prepare('SELECT * FROM requests WHERE id=?').bind(id).first();
    if (!row) return json({ error: 'Request not found.' }, 404);
    if (row.status !== 'pending') return json({ error: 'This request has already been reviewed.' }, 409);
    if (!env.SMTP_USER || !env.SMTP_PASS || !env.MAIL_FROM) return json({ error: 'Email is not configured. Set SMTP_USER, SMTP_PASS and MAIL_FROM in Cloudflare Worker settings before making a decision.' }, 503);
    const raw = token(), when = now();
    const changed = await env.DB.prepare('UPDATE requests SET status=?,qr_token_hash=?,decided_at=?,decided_by=? WHERE id=? AND status=?').bind(status, await digest(raw), when, staff.id, id, 'pending').run();
    if (!changed.meta?.changes) return json({ error: 'This request has already been reviewed.' }, 409);
    const updated = { ...row, status, decided_at: when };
    try { await emailDecision(updated, raw, env); }
    catch (error) {
      await env.DB.prepare('UPDATE requests SET status="pending",qr_token_hash=NULL,decided_at=NULL,decided_by=NULL WHERE id=? AND status=?').bind(id, status).run();
      console.error('Decision email failed:', error.message);
      return json({ error: 'Email could not be sent. The request remains pending; check email settings and try again.' }, 502);
    }
    return json({ request: publicRequest(updated), emailSent: true });
  }

  if (method === 'POST' && (path === '/api/scanner/verify' || path === '/api/staff/scanner/verify')) {
    if (path === '/api/staff/scanner/verify') {
      if (!await staffFor(request, env)) return json({ valid: false, decision: 'unauthorized', message: 'Please sign in.' }, 401);
    } else {
      const expected = String(env.SCANNER_API_KEY || '');
      const supplied = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || request.headers.get('X-Scanner-Key') || '';
      let mismatch = supplied.length ^ expected.length;
      for (let index = 0; index < Math.max(supplied.length, expected.length); index++) mismatch |= (supplied.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
      if (!expected) return json({ valid: false, decision: 'unavailable', message: 'Scanner integration is not configured.' }, 503);
      if (mismatch) return json({ valid: false, decision: 'unauthorized', message: 'Invalid scanner credentials.' }, 401);
    }
    const pass = String(body?.token || '');
    if (pass.length < 32 || pass.length > 200) return json({ valid: false, decision: 'invalid', message: 'QR pass is invalid.' }, 400);
    const row = await env.DB.prepare('SELECT * FROM requests WHERE qr_token_hash=?').bind(await digest(pass)).first();
    if (!row) return json({ valid: false, decision: 'invalid', message: 'QR pass is invalid.' });
    if (row.status === 'declined') return json({ valid: false, decision: 'declined', message: 'Your form is declined, you may give another reason to enter.', reference: row.reference });
    if (row.status === 'checked_in') return json({ valid: false, decision: 'already_used', message: 'This pass has already been used.', reference: row.reference });
    if (row.status !== 'accepted') return json({ valid: false, decision: 'pending', message: 'This visit has not been approved.', reference: row.reference });
    const staff = path === '/api/staff/scanner/verify' ? await staffFor(request, env) : null;
    const checked = await env.DB.prepare('UPDATE requests SET status="checked_in",checked_in_at=?,checked_in_by=? WHERE id=? AND status="accepted"').bind(now(), staff?.id || null, row.id).run();
    if (!checked.meta?.changes) return json({ valid: false, decision: 'already_used', message: 'This pass has already been used.', reference: row.reference });
    return json({ valid: true, decision: 'accepted', message: 'You may enter the campus.', reference: row.reference, name: row.name });
  }

  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    const headers = new Headers(secureHeaders);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        const response = await handleApi(request, env);
        for (const [name, value] of Object.entries(secureHeaders)) response.headers.set(name, value);
        return response;
      } catch (error) {
        console.error('DigiEntry request failed:', error.message);
        return json({ error: 'The service encountered an error. Please try again.' }, 500, secureHeaders);
      }
    }
    const asset = await env.ASSETS.fetch(request);
    for (const [name, value] of headers) asset.headers.set(name, value);
    return asset;
  }
};
