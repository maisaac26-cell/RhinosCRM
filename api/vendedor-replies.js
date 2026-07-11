'use strict';
const https = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

// ── Supabase ──────────────────────────────────────────────────────────────────
function sbReq(method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: new URL(SB_URL).hostname,
      path: '/rest/v1/' + path, method,
      headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
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
async function sbGet(path) { const r = await sbReq('GET', path); return Array.isArray(r) ? r : []; }

// ── Gmail token ───────────────────────────────────────────────────────────────
async function getGmailToken() {
  const cfg = await sbGet('rhinos_config?key=in.(gmail_refresh_token,gmail_access_token,gmail_token_expiry)');
  const map = {}; cfg.forEach(r => { map[r.key] = r.value; });
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
  if (!refreshed.access_token) throw new Error('No se pudo refrescar token Gmail');
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

// ── Gmail helpers ─────────────────────────────────────────────────────────────
function gmailReq(token, method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com', path, method,
      headers: {
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    if (payload) req.write(payload);
    req.end();
  });
}
const gmailGet = (token, path) => gmailReq(token, 'GET', path, null);

async function getMyEmail(token) {
  const p = await gmailGet(token, '/gmail/v1/users/me/profile');
  return (p.emailAddress || '').toLowerCase().trim();
}

function getHeader(msg, name) {
  return ((msg.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
}

function extractBodyText(payload, depth) {
  if (!payload || (depth || 0) > 6) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8').trim();
  }
  for (const part of (payload.parts || [])) {
    const t = extractBodyText(part, (depth || 0) + 1);
    if (t) return t;
  }
  return '';
}

function encodeEmail(to, subject, body, threadId, inReplyTo) {
  const subj64 = '=?UTF-8?B?' + Buffer.from(subject || '').toString('base64') + '?=';
  let raw = `MIME-Version: 1.0\r\nTo: ${to}\r\nSubject: ${subj64}\r\n`;
  if (inReplyTo) raw += `In-Reply-To: ${inReplyTo}\r\nReferences: ${inReplyTo}\r\n`;
  raw += `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { raw: encoded, ...(threadId ? { threadId } : {}) };
}

async function sendReply(token, to, subject, body, threadId, inReplyTo) {
  return gmailReq(token, 'POST', '/gmail/v1/users/me/messages/send',
    encodeEmail(to, subject, body, threadId, inReplyTo));
}

async function createDraft(token, to, subject, body, threadId, inReplyTo) {
  return gmailReq(token, 'POST', '/gmail/v1/users/me/drafts',
    { message: encodeEmail(to, subject, body, threadId, inReplyTo) });
}

// ── Lead creation ─────────────────────────────────────────────────────────────
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

// ── Claude ────────────────────────────────────────────────────────────────────
async function claudeChat(system, userMsg) {
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 800,
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

// Clasifica la intención del reply usando Claude Haiku (rápido y barato)
async function clasificarIntencion(texto) {
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 60,
    system: `Clasificá la intención de esta respuesta de un prospecto que recibió un email comercial.
Devolvé SOLO una de estas palabras (nada más, sin explicación):
- interesado: quiere saber más, responde positivamente, hace preguntas generales
- pide_demo: quiere una demo, una llamada, una reunión, ver cómo funciona
- pide_precio: pregunta específicamente el precio, costo, planes o suscripción
- rechazado: no le interesa, ya tiene solución, pide que no lo contacten más
- fuera_oficina: respuesta automática de vacaciones o fuera de oficina
- empleado: quien responde no es el dueño/decisor, lo deriva al dueño
- otras: cualquier otra cosa`,
    messages: [{ role: 'user', content: (texto || '').slice(0, 600) }]
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const t = (JSON.parse(raw).content?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
          const VALID = ['interesado','pide_demo','pide_precio','rechazado','fuera_oficina','empleado','otras'];
          resolve(VALID.includes(t) ? t : 'otras');
        } catch { resolve('otras'); }
      });
    });
    req.on('error', () => resolve('otras')); req.write(payload); req.end();
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

async function generarRespuesta(cfg, prospecto, historial, ultimoReply, intencion) {
  const firma     = buildFirma(cfg);
  const calcLink  = cfg.calendly || 'https://rhinosapp.vercel.app/#calculadora';
  const estiloRef = cfg.mensaje_ejemplo
    ? `\n\nESTILO DE REFERENCIA (adoptá este tono, NO copies el texto):\n"""\n${cfg.mensaje_ejemplo.slice(0,500)}\n"""`
    : '';

  // Instrucción específica según intención detectada
  const intentoCtx = intencion === 'pide_demo'
    ? `\nINTENCIÓN DETECTADA — DEMO/LLAMADA: Proponé un horario concreto o mandá el link de Calendly directamente: ${cfg.calendly || 'contactanos por WhatsApp'}. Sé directo, no hagas preguntas adicionales.`
    : intencion === 'pide_precio'
    ? `\nINTENCIÓN DETECTADA — PRECIO: Explicá que es suscripción mensual en pesos, todo incluido. Invitá a ver la calculadora de ahorro o agendar una llamada de 15 min para un precio personalizado según sus módulos.`
    : intencion === 'empleado'
    ? `\nINTENCIÓN DETECTADA — EMPLEADO: Quien respondió no es el decisor. Pedí amablemente el nombre y email/WhatsApp del dueño o gerente para enviarle la información directamente.`
    : '';

  const system = `Sos ${cfg.nombre_vendedor || 'del equipo comercial'} de "${cfg.razon_social}". Estás respondiendo una conversación de ventas por email con ${prospecto.empresa} (${prospecto.rubro || 'empresa'}, ${prospecto.localidad || 'Argentina'}).

PRODUCTO/SERVICIOS: ${cfg.servicios || ''}
LINK DE CONTACTO/DEMO: ${calcLink}${cfg.website ? `\nWEBSITE: ${cfg.website}` : ''}
${intentoCtx}
REGLAS ESTRICTAS:
- Español argentino, tono humano, directo y cálido — no suenes a robot ni a template
- Máximo 120 palabras en el cuerpo (sin contar firma)
- Si ya están muy interesados o piden hablar → pedí su número de WhatsApp para coordinar
- Si la consulta es muy técnica → "ya le paso tu consulta al equipo, te contactan directo"
- Terminá siempre con esta firma exacta (copiala tal cual, no la modifiques):
${firma}

Devolvé SOLO JSON: {"asunto":"...","cuerpo":"..."}. El cuerpo incluye texto + firma separados por \\n\\n. Texto plano.${estiloRef}`;

  const userMsg = `HISTORIAL DE CONVERSACIÓN (más recientes al final):\n${historial}\n\n---\nÚLTIMO MENSAJE DEL PROSPECTO (respondé a esto):\n${ultimoReply}`;

  const raw   = await claudeChat(system, userMsg);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSON inválido de Claude');
  return JSON.parse(match[0]);
}

// Notificación push vía /api/push cuando se detecta un lead caliente
function sendPushAlert(titulo, cuerpo) {
  const payload = JSON.stringify({ action: 'send', title: titulo, body: cuerpo, tag: 'lead_caliente' });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'rhinos-crm.vercel.app', path: '/api/push', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', () => resolve());
    req.write(payload); req.end();
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const summary = { revisados: 0, respondidos: 0, borradores: 0, pausados: 0, sin_novedad: 0, errors: [] };

  try {
    // Config
    const cfgRows = await sbGet('rhinos_config?key=in.(vendedor_razon_social,vendedor_servicios,vendedor_website,vendedor_whatsapp,vendedor_nombre_vendedor,vendedor_mensaje_ejemplo,vendedor_reply_modo,vendedor_reply_max,vendedor_calendly)');
    const cfgMap  = {}; cfgRows.forEach(r => { cfgMap[r.key] = r.value; });
    const cfg = {
      razon_social:    cfgMap.vendedor_razon_social    || 'nuestra empresa',
      servicios:       cfgMap.vendedor_servicios       || '',
      website:         cfgMap.vendedor_website         || '',
      whatsapp:        cfgMap.vendedor_whatsapp        || '',
      nombre_vendedor: cfgMap.vendedor_nombre_vendedor || '',
      mensaje_ejemplo: cfgMap.vendedor_mensaje_ejemplo || '',
      reply_modo:      cfgMap.vendedor_reply_modo      || 'draft',
      reply_max:       parseInt(cfgMap.vendedor_reply_max || '5', 10),
      calendly:        cfgMap.vendedor_calendly        || '',
    };

    const token   = await getGmailToken();
    const myEmail = await getMyEmail(token);
    const myUser  = myEmail.split('@')[0];

    // Prospectos con reply activo, no pausados, con thread de Gmail
    const prospects = await sbGet(
      'rhinos_prospectos?ia_reply=eq.true&ia_pausado=eq.false&estado=neq.invalido&order=ia_reply_fecha.asc&limit=40'
    );
    const conThread = prospects.filter(p => p.ia_gmail_thread_id);

    for (const p of conThread) {
      summary.revisados++;
      try {
        // Verificar max antes de hacer requests
        const currentCount = p.ia_auto_reply_count || 0;
        if (currentCount >= cfg.reply_max) {
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
            ia_pausado: true,
            notas: `⏸️ IA pausada automáticamente — se alcanzó el máximo de ${cfg.reply_max} respuestas. Continuá la conversación manualmente desde Gmail.`,
            updated_at: new Date().toISOString(),
          });
          summary.pausados++;
          continue;
        }

        // Obtener thread completo
        const thread   = await gmailGet(token, `/gmail/v1/users/me/threads/${p.ia_gmail_thread_id}?format=full`);
        const messages = thread.messages || [];
        if (messages.length < 2) { summary.sin_novedad++; continue; }

        // Separar mensajes nuestros de los del prospecto
        const historialLines     = [];
        let latestProspectMsgId  = null;  // Gmail internal ID
        let latestProspectHdrId  = null;  // RFC 2822 Message-ID (para In-Reply-To)
        let latestProspectText   = '';

        for (const msg of messages) {
          const from   = getHeader(msg, 'From').toLowerCase();
          const isOurs = from.includes(myEmail) || from.includes(myUser);
          const text   = extractBodyText(msg.payload).slice(0, 400);
          const quien  = isOurs ? 'Nosotros' : (p.empresa || 'Prospecto');
          if (text) historialLines.push(`[${quien}]: ${text.replace(/\n+/g, ' ')}`);
          if (!isOurs && text) {
            latestProspectMsgId = msg.id;
            latestProspectHdrId = getHeader(msg, 'Message-ID') || getHeader(msg, 'Message-Id');
            latestProspectText  = text;
          }
        }

        if (!latestProspectMsgId) { summary.sin_novedad++; continue; }

        // ¿Ya respondimos a este mensaje?
        if (p.ia_last_msg_id === latestProspectMsgId) {
          // Backfill snippet si todavía no lo tenemos (prospectos procesados antes de la feature)
          if (!p.ia_reply_snippet && latestProspectText) {
            sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
              ia_reply_snippet: latestProspectText.slice(0, 280),
              ia_intencion:     p.ia_intencion || await clasificarIntencion(latestProspectText),
            }).catch(() => {});
          }
          summary.sin_novedad++;
          continue;
        }

        // Clasificar intención del reply con Claude Haiku
        const intencion = await clasificarIntencion(latestProspectText);
        const now = new Date().toISOString();

        // Guardar intención y snippet de la respuesta del prospecto
        sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
          ia_intencion:     intencion,
          ia_reply_snippet: latestProspectText.slice(0, 280),
          updated_at:       now,
        }).catch(() => {});

        // Rechazado → marcar, pausar, no responder
        if (intencion === 'rechazado') {
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
            estado: 'rechazado', ia_pausado: true,
            ia_last_msg_id: latestProspectMsgId,
            notas: `🚫 Rechazó el contacto (${now.slice(0,10)}).`,
            updated_at: now,
          });
          summary.pausados++;
          continue;
        }

        // Fuera de oficina → reprogramar contacto en 10 días, no responder
        if (intencion === 'fuera_oficina') {
          const recontactar = new Date(Date.now() + 10 * 86400000).toISOString();
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
            ia_last_msg_id: latestProspectMsgId,
            ia_fecha_contacto: recontactar,
            updated_at: now,
          });
          summary.sin_novedad++;
          continue;
        }

        // Respuesta positiva → marcar interesado + crear lead en CRM
        await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, { estado: 'interesado', updated_at: now });
        await crearLeadSiNoExiste(p);

        // Push notification para leads calientes (fire-and-forget)
        if (['interesado', 'pide_demo'].includes(intencion)) {
          const emoji = intencion === 'pide_demo' ? '📅' : '🔥';
          const intencionLabel = intencion === 'pide_demo' ? 'Pide una demo/reunión' : 'Está interesado';
          sendPushAlert(
            `${emoji} Lead caliente — ${p.empresa}`,
            `${intencionLabel} · ${p.rubro || ''} ${p.localidad ? '· ' + p.localidad : ''}`
          ).catch(() => {});
        }

        // Generar respuesta con Claude, pasando la intención detectada
        const historial = historialLines.slice(-8).join('\n');
        const email     = await generarRespuesta(cfg, p, historial, latestProspectText, intencion);

        if (cfg.reply_modo === 'auto') {
          await sendReply(token, p.email, email.asunto, email.cuerpo, p.ia_gmail_thread_id, latestProspectHdrId);
          summary.respondidos++;
        } else {
          const draft = await createDraft(token, p.email, email.asunto, email.cuerpo, p.ia_gmail_thread_id, latestProspectHdrId);
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, { ia_draft_id: draft.id || null });
          summary.borradores++;
        }

        await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
          ia_auto_reply_count: currentCount + 1,
          ia_last_msg_id:      latestProspectMsgId,
          updated_at:          now,
        });

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
