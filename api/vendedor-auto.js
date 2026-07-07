// Cron diario — ejecuta follow-ups automáticos del Vendedor IA.
// Solo procesa prospectos contactados por la IA, no respuestas manuales.
'use strict';
const https = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

function sbReq(method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: new URL(SB_URL).hostname,
      path: '/rest/v1/' + path, method,
      headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sbGet(path) {
  const r = await sbReq('GET', path);
  return Array.isArray(r) ? r : [];
}

async function getGmailToken() {
  const cfg = await sbGet('rhinos_config?key=in.(gmail_refresh_token,gmail_access_token,gmail_token_expiry)');
  const map = {};
  cfg.forEach(r => { map[r.key] = r.value; });
  if (!map.gmail_refresh_token) throw new Error('gmail_refresh_token no configurado');

  const expired = !map.gmail_token_expiry || new Date(map.gmail_token_expiry) < new Date(Date.now() + 60000);
  if (!expired && map.gmail_access_token) return map.gmail_access_token;

  const rPayload = new URLSearchParams({
    refresh_token: map.gmail_refresh_token,
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    grant_type: 'refresh_token'
  }).toString();
  const refreshed = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(rPayload) }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject); req.write(rPayload); req.end();
  });
  if (!refreshed.access_token) throw new Error('No se pudo refrescar el token');

  const newExpiry = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
  const upd = JSON.stringify([
    { key: 'gmail_access_token', value: refreshed.access_token, updated_at: new Date().toISOString() },
    { key: 'gmail_token_expiry', value: newExpiry, updated_at: new Date().toISOString() }
  ]);
  https.request({
    hostname: new URL(SB_URL).hostname, path: '/rest/v1/rhinos_config', method: 'POST',
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(upd),
      'Prefer': 'resolution=merge-duplicates,return=minimal' }
  }, () => {}).end(upd);
  return refreshed.access_token;
}

async function sendGmail(token, to, subject, bodyText) {
  const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject || '').toString('base64') + '?=';
  const raw = `MIME-Version: 1.0\r\nTo: ${to}\r\nSubject: ${encodedSubject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText}`;
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = JSON.stringify({ raw: encoded });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let raw2 = ''; res.on('data', c => raw2 += c);
      res.on('end', () => { try { resolve(JSON.parse(raw2)); } catch { resolve({}); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

async function hasReply(token, threadId) {
  if (!threadId) return false;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path: `/gmail/v1/users/me/threads/${threadId}?format=minimal`,
      method: 'GET', headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve((JSON.parse(raw).messages || []).length > 1); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false)); req.end();
  });
}

async function claudeChat(system, userMsg) {
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 512,
    system, messages: [{ role: 'user', content: userMsg }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw).content?.[0]?.text || ''); } catch { reject(new Error('Claude error')); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const summary = { revisados: 0, respondieron: 0, followup_enviados: 0, frios: 0, errors: [] };

  try {
    const cfgRows = await sbGet('rhinos_config?key=in.(vendedor_razon_social,vendedor_servicios,vendedor_tono,vendedor_followup_dias)');
    const cfgMap = {};
    cfgRows.forEach(r => { cfgMap[r.key] = r.value; });
    const razon_social = cfgMap.vendedor_razon_social || 'nuestra empresa';
    const servicios = cfgMap.vendedor_servicios || 'servicios de gestión comercial';
    const tono = cfgMap.vendedor_tono || 'profesional';
    const diasMin = parseInt(cfgMap.vendedor_followup_dias || '3', 10);

    const cutoff = new Date(Date.now() - diasMin * 86400000).toISOString();
    const pendientes = await sbGet(
      `rhinos_prospectos?ia_contactado=eq.true&ia_reply=eq.false&ia_followup_count=lt.2&ia_fecha_contacto=lt.${encodeURIComponent(cutoff)}&estado=neq.frio&order=ia_fecha_contacto.asc&limit=30`
    );

    if (!pendientes.length) return res.json({ ok: true, summary });

    let token;
    try { token = await getGmailToken(); }
    catch(e) { return res.json({ ok: false, error: 'Gmail: ' + e.message, summary }); }

    for (const p of pendientes) {
      summary.revisados++;
      try {
        const now = new Date().toISOString();
        const replied = await hasReply(token, p.ia_gmail_thread_id);

        if (replied) {
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, { ia_reply: true, ia_reply_fecha: now, estado: 'interesado', updated_at: now });
          summary.respondieron++;
          continue;
        }

        const system = `Sos el vendedor de "${razon_social}". Ofrecemos: ${servicios}. Tono: ${tono}. Es un follow-up: cambiá el ángulo del mensaje anterior. Devolvé SOLO JSON: {"asunto":"...","cuerpo":"..."}. Máximo 80 palabras en el cuerpo.`;
        const userMsg = `Empresa: ${p.empresa}\nRubro: ${p.rubro || ''}\nEmail anterior — Asunto: ${p.ia_email_asunto}\nCuerpo: ${p.ia_email_body}`;
        const raw = await claudeChat(system, userMsg);
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('JSON inválido de Claude');
        const email = JSON.parse(match[0]);

        const sent = await sendGmail(token, p.email, email.asunto, email.cuerpo);
        const newCount = (p.ia_followup_count || 0) + 1;
        const nuevoEstado = newCount >= 2 ? 'frio' : 'follow_up_' + newCount;

        await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
          ia_followup_count: newCount, ia_followup_fecha: now,
          ia_gmail_thread_id: sent.threadId || p.ia_gmail_thread_id,
          estado: nuevoEstado, updated_at: now
        });
        if (nuevoEstado === 'frio') summary.frios++; else summary.followup_enviados++;
      } catch(e) {
        summary.errors.push({ empresa: p.empresa, error: e.message });
      }
      await new Promise(r => setTimeout(r, 600));
    }
    return res.json({ ok: true, summary });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message, summary });
  }
};
