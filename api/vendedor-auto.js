// Cron diario lun-vie 9am — contacto inicial + follow-ups del Vendedor IA.
// 1. Manda emails iniciales a prospectos en cola (estado='nuevo') hasta max_dia.
// 2. Envía follow-ups a contactados sin respuesta pasados followup_dias días.
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
  if (!refreshed.access_token) throw new Error('No se pudo refrescar el token de Gmail');

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

function buildMultipartRaw(to, subject, textBody, prospId) {
  const boundary = 'RHINOS' + Date.now().toString(36);
  const subj64 = '=?UTF-8?B?' + Buffer.from(subject || '').toString('base64') + '?=';
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const htmlBody = textBody.split('\n\n')
    .map(para => `<p style="margin:0 0 14px">${esc(para).replace(/\n/g,'<br>')}</p>`)
    .join('');
  const pixel = prospId
    ? `<img src="https://rhinos-crm.vercel.app/api/vendedor-track?id=${encodeURIComponent(prospId)}" width="1" height="1" alt="" style="display:none">`
    : '';
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1a1a1a;max-width:580px;padding:24px 20px">${htmlBody}${pixel}</body></html>`;
  return (
    `MIME-Version: 1.0\r\nTo: ${to}\r\nSubject: ${subj64}\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${textBody}\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n\r\n` +
    `--${boundary}--`
  );
}

async function sendGmail(token, to, subject, bodyText, prospId) {
  const encoded = Buffer.from(buildMultipartRaw(to, subject, bodyText, prospId))
    .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
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

async function crearLeadSiNoExiste(prospecto) {
  try {
    const ex = await sbGet(`rhinos_leads?email=eq.${encodeURIComponent(prospecto.email)}&limit=1`);
    if (ex.length > 0) return;
    const { randomUUID } = require('crypto');
    const now = new Date().toISOString();
    await sbReq('POST', 'rhinos_leads', {
      id: randomUUID(), name: prospecto.nombre_contacto || '', company: prospecto.empresa || '',
      email: prospecto.email, phone: prospecto.telefono || '',
      source: 'Vendedor IA', status: 'nuevo', temperature: 'caliente',
      notes: `Vendedor IA — respondió al email. Rubro: ${prospecto.rubro || ''}${prospecto.localidad ? ' · ' + prospecto.localidad : ''}`,
      created_at: now, updated_at: now,
    });
  } catch(e) { /* non-critical */ }
}

function gmailGet(token, path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({})); req.end();
  });
}

function extractBodyText(parts) {
  let text = '';
  for (const p of (parts || [])) {
    if (p.mimeType === 'text/plain' && p.body?.data) {
      text += Buffer.from(p.body.data, 'base64url').toString('utf-8');
    }
    if (p.parts) text += extractBodyText(p.parts);
  }
  return text;
}

async function checkBounces(token) {
  const EMAIL_RE   = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const SKIP_HOSTS = /mailer-daemon|postmaster|google|noreply|bounce|example\.com/i;

  const q    = encodeURIComponent('from:mailer-daemon newer_than:2d');
  const list = await gmailGet(token, `/gmail/v1/users/me/messages?q=${q}&maxResults=50`);
  const msgs = (list.messages || []).slice(0, 30);

  const bounced = new Map(); // email → razon

  for (const msg of msgs) {
    const full   = await gmailGet(token, `/gmail/v1/users/me/messages/${msg.id}?format=full`);
    const body   = extractBodyText(full.payload?.parts || [full.payload]) + ' ' + (full.snippet || '');
    const isSpam = /5\.7\.|spam|calificado|filtro|blocked|blacklist/i.test(body);
    const razon  = isSpam
      ? '🚫 Servidor rechazó como spam — revisar contenido del email o dominio de envío'
      : '❌ Email rebotado — dirección no existe o buzón lleno';
    const found = (body.match(EMAIL_RE) || []);
    found.forEach(e => {
      const norm = e.toLowerCase();
      if (!SKIP_HOSTS.test(norm.split('@')[1] || '')) bounced.set(norm, razon);
    });
  }

  return [...bounced.entries()].map(([email, razon]) => ({ email, razon }));
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
    model: 'claude-haiku-4-5-20251001', max_tokens: 700,
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

function buildFirma(cfg) {
  const lines = ['--'];
  if (cfg.nombre_vendedor) lines.push(cfg.nombre_vendedor);
  lines.push(cfg.razon_social || '');
  if (cfg.whatsapp) lines.push(`💬 WhatsApp: https://wa.me/${cfg.whatsapp}`);
  if (cfg.website)  lines.push(`🌐 ${cfg.website}`);
  return lines.join('\n');
}

function buildEmailSystem(cfg, esFollowup) {
  // Sanitizar el ejemplo: si tiene muchos emojis/bullets probablemente sea un pitch de venta
  // que haría que Claude genere emails spam. Solo usarlo si parece un email personal limpio.
  const ejemploLimpio = cfg.mensaje_ejemplo || '';
  const esEjemploSpam = (ejemploLimpio.match(/[📦🛒💳🧾📊📱✅❌🎯🦏👉]/gu) || []).length > 2
    || (ejemploLimpio.match(/^[•\-\*]/gm) || []).length > 2;
  const estiloRef = (!esEjemploSpam && ejemploLimpio.length > 20)
    ? `\n\nTONO DE REFERENCIA (solo el tono, NO la estructura ni el contenido):\n"""\n${ejemploLimpio.slice(0, 300)}\n"""`
    : '';
  const calcLink = 'https://rhinosapp.vercel.app/#calculadora';
  const firma    = buildFirma(cfg);

  if (esFollowup) {
    return `Sos ${cfg.nombre_vendedor || 'del equipo'} de "${cfg.razon_social}". Ya le escribiste a esta empresa y no respondió. Escribí un segundo contacto muy breve en español rioplatense.

REGLAS ANTI-SPAM (críticas):
- Máximo 45 palabras en el cuerpo (SIN firma)
- Sin emojis en el asunto ni en el cuerpo
- Sin "hacemos seguimiento", "te quería recordar", "perdiste mi email"
- Sin listas ni bullets
- Ángulo diferente: hacé UNA pregunta sobre su negocio, o mencioná un resultado concreto de otro cliente similar
- Un solo link integrado en el texto (no en línea sola): ${calcLink}
- Firma exacta sin modificar:\n${firma}

Devolvé SOLO JSON: {"asunto":"...","cuerpo":"..."}. El cuerpo incluye texto + firma separados por \\n\\n. Texto plano.${estiloRef}`;
  }

  // Truncar servicios para que no contamine el prompt con el pitch completo
  const serviciosCorto = (cfg.servicios || '').slice(0, 120).split('\n')[0];
  return `Sos ${cfg.nombre_vendedor || 'del equipo'} de "${cfg.razon_social}" — sistema de gestión para PyMEs argentinas (${serviciosCorto}). Vas a escribirle a una empresa.

OBJETIVO: Un email que parezca escrito a mano, pase filtros anti-spam y que el dueño quiera leer.

REGLAS DE ENTREGABILIDAD (no las rompas):
- Máximo 70 palabras en el cuerpo (SIN firma)
- NINGÚN emoji en el asunto
- NINGÚN bullet point ni lista en el cuerpo
- NINGUNA palabra spam: "oferta", "suscripción", "precio", "calculá", "ahorrar", "gratis", "garantía"
- Un SOLO link externo, integrado en una oración natural (no en línea sola)
- Sin signos de exclamación en el asunto
- Sin "espero que estén bien", sin "me dirijo a usted", sin "vimos que manejan"
- Tono: directo y natural, persona hablándole a persona

ESTRUCTURA DEL CUERPO:
Frase 1: algo específico de su rubro que muestre que sabés de su actividad
Frase 2: qué hace "${cfg.razon_social}" y cómo puede servirles concretamente
Frase 3: invitación simple con el link: ${calcLink}
Firma exacta sin modificar:\n${firma}

ASUNTO — 3 variantes, NINGUNA con emoji ni signos de exclamación:
asunto_a: nombre de la empresa + tema específico (ej: "Du Graty — gestión de stock")
asunto_b: pregunta directa sobre su negocio (ej: "¿Cómo manejan el inventario en Du Graty?")
asunto_c: súper corto, 3-4 palabras máximo (ej: "Para la ferretería")

Devolvé SOLO JSON: {"asunto_a":"...","asunto_b":"...","asunto_c":"...","cuerpo":"..."}. Cuerpo incluye texto + \\n\\n + firma. Texto plano, sin markdown.${estiloRef}`;
}

async function generarEmail(cfg, prospecto, esFollowup, emailAnterior) {
  const system = buildEmailSystem(cfg, esFollowup);
  const userMsg = esFollowup
    ? `Empresa: ${prospecto.empresa}\nRubro: ${prospecto.rubro || ''}\nEmail anterior — Asunto: ${emailAnterior.asunto}\nCuerpo: ${emailAnterior.cuerpo}`
    : `Empresa: ${prospecto.empresa}\nContacto: ${prospecto.nombre_contacto || ''}\nRubro: ${prospecto.rubro || ''}\nLocalidad: ${prospecto.localidad || ''}`;

  const raw = await claudeChat(system, userMsg);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSON inválido de Claude');
  const parsed = JSON.parse(match[0]);

  if (!esFollowup && parsed.asunto_a) {
    const v = ['a','b','c'][Math.floor(Math.random() * 3)];
    return { asunto: parsed[`asunto_${v}`] || parsed.asunto_a, cuerpo: parsed.cuerpo, variant: v };
  }
  return { asunto: parsed.asunto || '', cuerpo: parsed.cuerpo, variant: null };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const summary = {
    iniciales_enviados: 0,
    followup_enviados: 0,
    respondieron: 0,
    frios: 0,
    rebotes: 0,
    errors: []
  };

  try {
    // Cargar config
    const cfgRows = await sbGet('rhinos_config?key=in.(vendedor_razon_social,vendedor_servicios,vendedor_tono,vendedor_followup_dias,vendedor_max_dia,vendedor_mensaje_ejemplo,vendedor_website,vendedor_whatsapp,vendedor_nombre_vendedor)');
    const cfgMap = {};
    cfgRows.forEach(r => { cfgMap[r.key] = r.value; });
    const cfg = {
      razon_social:    cfgMap.vendedor_razon_social || 'nuestra empresa',
      servicios:       cfgMap.vendedor_servicios    || 'servicios de gestión comercial',
      tono:            cfgMap.vendedor_tono         || 'profesional',
      followup_dias:   parseInt(cfgMap.vendedor_followup_dias || '3', 10),
      max_dia:         parseInt(cfgMap.vendedor_max_dia       || '20', 10),
      mensaje_ejemplo: cfgMap.vendedor_mensaje_ejemplo || '',
      website:         cfgMap.vendedor_website         || '',
      whatsapp:        cfgMap.vendedor_whatsapp        || '',
      nombre_vendedor: cfgMap.vendedor_nombre_vendedor || '',
    };

    let token;
    try { token = await getGmailToken(); }
    catch(e) { return res.json({ ok: false, error: 'Gmail: ' + e.message, summary }); }

    // ── PASO 0: detectar y limpiar rebotes de las últimas 48hs ──────────
    try {
      const bouncedEmails = await checkBounces(token);
      if (bouncedEmails.length) {
        // Cargar prospectos que tengan esos emails para cruzar
        const todos = await sbGet('rhinos_prospectos?select=id,email&ia_contactado=eq.true&limit=5000');
        const prospMap = {};
        todos.forEach(p => { if (p.email) prospMap[p.email.toLowerCase().trim()] = p.id; });

        for (const { email, razon } of bouncedEmails) {
          const id = prospMap[email];
          if (!id) continue;
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${id}`, {
            estado:      'invalido',
            notas:       razon,
            updated_at:  new Date().toISOString(),
          });
          summary.rebotes++;
        }
      }
    } catch(e) {
      summary.errors.push({ tipo: 'bounce_check', error: e.message });
    }

    let enviados = 0;

    // ── PASO 1: contacto inicial (estado='nuevo', ia_contactado=false) ──
    const enCola = await sbGet(
      `rhinos_prospectos?estado=eq.nuevo&ia_contactado=eq.false&order=created_at.asc&limit=${cfg.max_dia}`
    );

    for (const p of enCola) {
      if (enviados >= cfg.max_dia) break;
      try {
        const email = await generarEmail(cfg, p, false, null);
        const sent  = await sendGmail(token, p.email, email.asunto, email.cuerpo, null); // sin pixel en primer email
        const now   = new Date().toISOString();
        await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
          estado: 'contactado', ia_contactado: true, ia_fecha_contacto: now,
          ia_gmail_thread_id: sent.threadId || null,
          ia_gmail_msg_id:    sent.id       || null,
          ia_email_asunto:    email.asunto,
          ia_email_body:      email.cuerpo,
          ia_subject_variant: email.variant || null,
          updated_at:         now,
        });
        summary.iniciales_enviados++;
        enviados++;
      } catch(e) {
        summary.errors.push({ empresa: p.empresa, tipo: 'inicial', error: e.message });
      }
      // Delay variable (3-8s) para simular comportamiento humano
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
    }

    // ── PASO 2: follow-ups (ia_contactado=true, sin respuesta, vencido) ──
    const cutoff = new Date(Date.now() - cfg.followup_dias * 86400000).toISOString();
    const pendientes = await sbGet(
      `rhinos_prospectos?ia_contactado=eq.true&ia_reply=eq.false&ia_followup_count=lt.2&ia_fecha_contacto=lt.${encodeURIComponent(cutoff)}&estado=not.in.(frio,invalido)&order=ia_fecha_contacto.asc&limit=30`
    );

    for (const p of pendientes) {
      try {
        const now     = new Date().toISOString();
        const replied = await hasReply(token, p.ia_gmail_thread_id);

        if (replied) {
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, { ia_reply: true, ia_reply_fecha: now, estado: 'interesado', updated_at: now });
          await crearLeadSiNoExiste(p);
          summary.respondieron++;
          continue;
        }

        const email    = await generarEmail(cfg, p, true, { asunto: p.ia_email_asunto, cuerpo: p.ia_email_body });
        const sent     = await sendGmail(token, p.email, email.asunto, email.cuerpo);
        const newCount = (p.ia_followup_count || 0) + 1;
        const estado   = newCount >= 2 ? 'frio' : 'follow_up_' + newCount;

        await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
          ia_followup_count: newCount, ia_followup_fecha: now,
          ia_gmail_thread_id: sent.threadId || p.ia_gmail_thread_id,
          estado, updated_at: now,
        });
        if (estado === 'frio') summary.frios++; else summary.followup_enviados++;
      } catch(e) {
        summary.errors.push({ empresa: p.empresa, tipo: 'followup', error: e.message });
      }
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 4000));
    }

    return res.json({ ok: true, summary });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message, summary });
  }
};
