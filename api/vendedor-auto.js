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
    const timer = setTimeout(() => { req.destroy(); resolve({}); }, 10000);
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
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
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
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Token refresh timeout (10s)')); }, 10000);
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(rPayload) }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); }); req.write(rPayload); req.end();
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

function buildMultipartRaw(to, subject, textBody, prospId, fromDisplay, gmailFrom) {
  // Boundary aleatorio — evita que filtros bloqueen por firma conocida
  const boundary = 'MP' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const subj64 = '=?UTF-8?B?' + Buffer.from(subject || '').toString('base64') + '?=';

  // Footer de opt-out — requerido por CAN-SPAM y reduce marcaciones manuales como spam
  const unsubLine = '\n\n---\nPara no recibir más emails: respondé "no gracias" a este mensaje.';
  const fullText = textBody + unsubLine;

  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const htmlBody = fullText.split('\n\n')
    .map(para => `<p style="margin:0 0 14px">${esc(para).replace(/\n/g,'<br>')}</p>`)
    .join('');
  const pixel = prospId
    ? `<img src="https://rhinos-crm.vercel.app/api/vendedor?action=track&id=${encodeURIComponent(prospId)}" width="1" height="1" alt="" style="display:none">`
    : '';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1a1a1a;max-width:580px;margin:0 auto;padding:24px 20px">${htmlBody}${pixel}</body></html>`;

  // From con nombre real mejora la apertura y disminuye marcaciones como spam
  const fromAddr = gmailFrom || 'comercial@rhinosapp.com';
  const fromHdr  = fromDisplay
    ? `=?UTF-8?B?${Buffer.from(fromDisplay).toString('base64')}?= <${fromAddr}>`
    : fromAddr;

  return (
    `MIME-Version: 1.0\r\nFrom: ${fromHdr}\r\nTo: ${to}\r\nSubject: ${subj64}\r\n` +
    `List-Unsubscribe: <mailto:${fromAddr}?subject=Unsubscribe>\r\n` +
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fullText}\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n\r\n` +
    `--${boundary}--`
  );
}

async function sendGmail(token, to, subject, bodyText, prospId, fromDisplay, gmailFrom) {
  const encoded = Buffer.from(buildMultipartRaw(to, subject, bodyText, prospId, fromDisplay, gmailFrom))
    .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const payload = JSON.stringify({ raw: encoded });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Gmail send timeout (15s)')); }, 15000);
    const req = https.request({
      hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let raw2 = ''; res.on('data', c => raw2 += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(raw2)); } catch { resolve({}); } });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); }); req.write(payload); req.end();
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
    const timer = setTimeout(() => { req.destroy(); resolve({}); }, 8000);
    const req = https.request({
      hostname: 'gmail.googleapis.com', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', () => { clearTimeout(timer); resolve({}); }); req.end();
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
  const list = await gmailGet(token, `/gmail/v1/users/me/messages?q=${q}&maxResults=20`);
  // Limit to 10 and run in parallel — avoids 30 × 8s = 240s sequential worst-case
  const msgs = (list.messages || []).slice(0, 10);

  const bounced = new Map(); // email → razon

  await Promise.all(msgs.map(async (msg) => {
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
  }));

  return [...bounced.entries()].map(([email, razon]) => ({ email, razon }));
}

function hasReply(token, threadId) {
  if (!threadId) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { req.destroy(); resolve(false); }, 8000);
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path: `/gmail/v1/users/me/threads/${threadId}?format=minimal`,
      method: 'GET', headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { clearTimeout(timer); try { resolve((JSON.parse(raw).messages || []).length > 1); } catch { resolve(false); } });
    });
    req.on('error', () => { clearTimeout(timer); resolve(false); }); req.end();
  });
}

async function claudeChat(system, userMsg) {
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 700,
    system, messages: [{ role: 'user', content: userMsg }]
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Claude API timeout (30s)')); }, 30000);
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(raw);
          const text = parsed.content?.[0]?.text;
          if (!text) reject(new Error(`Claude API: ${parsed.error?.message || parsed.type || raw.slice(0, 120)}`));
          else resolve(text);
        } catch { reject(new Error('Claude parse error: ' + raw.slice(0, 120))); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(payload); req.end();
  });
}

function buildFirma(cfg) {
  const lines = ['--'];
  if (cfg.nombre_vendedor) lines.push(cfg.nombre_vendedor);
  lines.push(cfg.razon_social || '');
  if (cfg.whatsapp) lines.push(`WhatsApp: https://wa.me/${cfg.whatsapp}`);
  if (cfg.calendly) lines.push(`Agenda una llamada: ${cfg.calendly}`);
  if (cfg.website)  lines.push(cfg.website);
  return lines.join('\n');
}

function normalizePhone(phone) {
  if (!phone) return null;
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('54')) p = '54' + p;
  if (p.length < 10 || p.length > 15) return null;
  return p + '@c.us';
}

function sendWhatsAppMsgLocal(instanceId, token, chatId, message) {
  const payload = JSON.stringify({ chatId, message });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.green-api.com',
      path: `/waInstance${instanceId}/sendMessage/${token}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({ error: 'network' })); req.write(payload); req.end();
  });
}

function getRubroContext(rubro) {
  const r = (rubro || '').toLowerCase();
  if (/ferreter/.test(r))                       return 'Miles de referencias de stock, pedidos a proveedores, clientes de cuenta corriente';
  if (/distribui/.test(r))                      return 'Volumen de remitos, facturas y cuentas corrientes de clientes mayoristas';
  if (/restaurant|pizzer|hamburgue|bar|caf|gastro|bodeg|parrilla|delivery/.test(r)) return 'Control de insumos, merma, costos de recetas y cierre de caja diario';
  if (/farmacia/.test(r))                       return 'Vencimientos, stock de medicamentos y trazabilidad';
  if (/ropa|indument|boutique|calzado|zapat|lencer/.test(r)) return 'Tallas, colores, temporadas y cuentas corrientes de clientes';
  if (/supermercado|almac|despensa|kiosk/.test(r)) return 'Stock de miles de ítems, proveedores y cajas';
  if (/electr/.test(r))                         return 'Stock técnico, garantías, reparaciones y órdenes de trabajo';
  if (/construc|corralo|mader|pintur|sanitar|plomer|cerrajer/.test(r)) return 'Presupuestos de obra, materiales y clientes de cuenta';
  if (/optic/.test(r))                          return 'Stock de marcos, lentes, pedidos a laboratorio';
  if (/carnicer|fiambr/.test(r))               return 'Control de cortes, peso y ventas por mostrador';
  if (/panader|confiter|pasteler/.test(r))      return 'Producción diaria, insumos y control de turnos';
  if (/veterina/.test(r))                       return 'Fichas de pacientes, stock de medicamentos y turnos';
  if (/taller|mecanic|automotor/.test(r))       return 'Órdenes de trabajo, repuestos y historial de vehículos';
  if (/limp|higiene/.test(r))                   return 'Rutinas, stock de productos e historial de clientes';
  if (/mayorist|cash and carry/.test(r))        return 'Volumen, listas de precio por cliente y facturación masiva';
  return 'Facturación electrónica AFIP, stock y cuentas corrientes';
}

function buildEmailSystem(cfg, esFollowup, abrioEmail) {
  const ejemploLimpio = cfg.mensaje_ejemplo || '';
  const esEjemploSpam = (ejemploLimpio.match(/[📦🛒💳🧾📊📱✅❌🎯🦏👉]/gu) || []).length > 2
    || (ejemploLimpio.match(/^[•\-\*]/gm) || []).length > 2;
  const estiloRef = (!esEjemploSpam && ejemploLimpio.length > 20)
    ? `\n\nTONO DE REFERENCIA (solo el tono, NO la estructura ni el contenido):\n"""\n${ejemploLimpio.slice(0, 300)}\n"""`
    : '';
  const calcLink = cfg.calendly || 'https://rhinosapp.vercel.app/#calculadora';
  const firma    = buildFirma(cfg);

  // Lista de palabras que activan filtros de spam — Claude no debe usar ninguna
  const PALABRAS_SPAM = '"oferta", "precio", "suscripción", "calculá", "ahorrar", "ahorro", "gratis", "garantía", "descuento", "exclusivo", "urgente", "oportunidad", "limitado", "tiempo limitado", "actúa ahora", "hacé clic", "click aquí", "visitá nuestra", "100%", "beneficio", "rentabilidad", "sin costo", "sin cargo", "probá gratis", "felicitaciones", "ganaste", "promo"';

  if (esFollowup) {
    if (abrioEmail) {
      return `Sos ${cfg.nombre_vendedor || 'del equipo'} de "${cfg.razon_social}". Le escribiste a esta empresa, vieron tu email pero no respondieron. Escribí un segundo contacto muy breve en español rioplatense.

REGLAS ABSOLUTAS (romperlas arruina la entregabilidad):
- Máximo 35 palabras en el cuerpo (SIN firma) — la brevedad es clave
- Cero emojis en asunto ni en cuerpo
- No menciones que "viste que abrieron el email" — no es natural
- Podés preguntar si llegó bien: "No sé si mi email llegó a la bandeja correcta"
- Sin presión, sin urgencia, sin "última oportunidad"
- UNA sola pregunta concreta sobre su negocio o rubro
- CERO links — no incluyas ningún link en este email
- Sin palabras spam: ${PALABRAS_SPAM}
- Asunto: máximo 40 caracteres, sin signos de exclamación, sin interrogación
- Firma exacta sin modificar:\n${firma}

Devolvé SOLO JSON: {"asunto":"...","cuerpo":"..."}. Cuerpo = texto + \\n\\n + firma. Texto plano sin markdown.${estiloRef}`;
    }
    return `Sos ${cfg.nombre_vendedor || 'del equipo'} de "${cfg.razon_social}". Le escribiste a esta empresa y no hubo respuesta. Escribí un segundo contacto brevísimo en español rioplatense.

REGLAS ABSOLUTAS:
- Máximo 40 palabras en el cuerpo (SIN firma)
- Cero emojis en asunto ni en cuerpo
- NO menciones el email anterior, empezá de cero como si fuera el primero
- Ángulo completamente diferente: una observación concreta sobre su industria o ciudad, luego UNA pregunta
- CERO links — no incluyas ningún link en este follow-up
- Sin "hacemos seguimiento", "te quería recordar", "en relación a mi email"
- Sin palabras spam: ${PALABRAS_SPAM}
- Asunto: máximo 40 caracteres, sin signos de exclamación
- Firma exacta sin modificar:\n${firma}

Devolvé SOLO JSON: {"asunto":"...","cuerpo":"..."}. Cuerpo = texto + \\n\\n + firma. Texto plano sin markdown.${estiloRef}`;
  }

  const serviciosCorto = (cfg.servicios || '').slice(0, 120).split('\n')[0];
  return `Sos ${cfg.nombre_vendedor || 'del equipo'} de "${cfg.razon_social}" — sistema de gestión para PyMEs argentinas (${serviciosCorto}).

MISIÓN: Escribir UN email que llegue a la bandeja principal (no a Promociones ni Spam) y que el dueño quiera responder. Tiene que parecer un email de persona a persona, no una campaña.

PERSONALIZACIÓN OBLIGATORIA:
- Recibirás "Datos reales" con rating Google Maps, reseñas, dirección. Usá esa info en la primera oración de forma orgánica. Si no hay datos, usá la localidad o el rubro.
- El "dolor típico" del rubro es lo que el dueño siente todos los días — conectalo naturalmente con lo que hace "${cfg.razon_social}".

REGLAS DE ENTREGABILIDAD (críticas — cada violación aumenta el score de spam):
- CUERPO: máximo 65 palabras totales (sin contar firma)
- ASUNTO: máximo 50 caracteres — sin emojis, sin signos de exclamación, sin mayúsculas seguidas
- CERO bullets, listas ni guiones como estructura
- UN SOLO link externo, dentro de una oración (nunca en línea sola): ${calcLink}
- Cero palabras spam: ${PALABRAS_SPAM}
- Cero frases corporativas: "espero que estén bien", "me dirijo a ustedes", "adjunto información"
- Cero presión: no escribas urgencia, plazos ni "última oportunidad"
- Tono: conversacional, como si le escribieras a un conocido que tiene ese negocio

ESTRUCTURA DEL CUERPO (3 oraciones, máx):
1. Una observación concreta del negocio (dato real de Maps, o rubro + localidad)
2. Problema específico de esa industria + cómo "${cfg.razon_social}" lo resuelve (en palabras simples)
3. Llamado a la acción natural con el link integrado
[salto de línea doble]
[Firma exacta, no la modifiques:]
${firma}

ASUNTO — 3 variantes, evaluá cuál suena más personal para ESTA empresa:
asunto_a: nombre de empresa + tema del rubro (ej: "Farmacia Del Sol — vencimientos y stock")
asunto_b: mini-pregunta específica del negocio (ej: "¿Cómo manejan los pedidos en Farmacia Del Sol?")
asunto_c: cortísimo, 2-4 palabras con nombre de empresa (ej: "Para Farmacia Del Sol")

Devolvé SOLO JSON válido: {"asunto_a":"...","asunto_b":"...","asunto_c":"...","cuerpo":"..."}
El cuerpo incluye el texto + \\n\\n + firma. Texto plano, sin markdown, sin backticks.${estiloRef}`;
}

async function generarEmail(cfg, prospecto, esFollowup, emailAnterior, abrioEmail) {
  const system = buildEmailSystem(cfg, esFollowup, abrioEmail);
  const rubroCtx = getRubroContext(prospecto.rubro);
  const userMsg = esFollowup
    ? `Empresa: ${prospecto.empresa}\nRubro: ${prospecto.rubro || ''} (dolor típico: ${rubroCtx})\nEmail anterior — Asunto: ${emailAnterior.asunto}\nCuerpo: ${emailAnterior.cuerpo}`
    : `Empresa: ${prospecto.empresa}\nContacto: ${prospecto.nombre_contacto || ''}\nRubro: ${prospecto.rubro || ''} (dolor típico: ${rubroCtx})\nLocalidad: ${prospecto.localidad || ''}${prospecto.notas ? '\nDatos reales: ' + prospecto.notas : ''}`;

  const raw = await claudeChat(system, userMsg);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSON inválido de Claude');
  const parsed = JSON.parse(match[0]);

  if (!esFollowup && parsed.asunto_a) {
    // Usar el winner A/B 70% del tiempo, explorar el otro 30%
    let v;
    const winner = cfg.ab_winner;
    if (winner && ['a','b','c'].includes(winner) && Math.random() < 0.7) {
      v = winner;
    } else {
      v = ['a','b','c'][Math.floor(Math.random() * 3)];
    }
    return { asunto: parsed[`asunto_${v}`] || parsed.asunto_a, cuerpo: parsed.cuerpo, variant: v };
  }
  return { asunto: parsed.asunto || '', cuerpo: parsed.cuerpo, variant: null };
}

// Calcula la variante de asunto con mejor tasa de apertura y la guarda en config
async function optimizarAB() {
  try {
    const rows = await sbGet('rhinos_prospectos?select=ia_subject_variant,ia_abierto&ia_contactado=eq.true&ia_subject_variant=neq.null&limit=5000');
    const stats = { a: { total: 0, abiertos: 0 }, b: { total: 0, abiertos: 0 }, c: { total: 0, abiertos: 0 } };
    for (const r of rows) {
      const v = r.ia_subject_variant;
      if (!stats[v]) continue;
      stats[v].total++;
      if (r.ia_abierto) stats[v].abiertos++;
    }
    let winner = null; let bestRate = 0;
    for (const [v, s] of Object.entries(stats)) {
      if (s.total < 15) continue; // muestra mínima para ser estadísticamente válido
      const rate = s.abiertos / s.total;
      if (rate > bestRate) { bestRate = rate; winner = v; }
    }
    if (winner) {
      await sbReq('POST', 'rhinos_config', [{ key: 'vendedor_ab_winner', value: winner, updated_at: new Date().toISOString() }]);
    }
    return { winner, rates: Object.fromEntries(Object.entries(stats).map(([v, s]) => [v, s.total > 0 ? Math.round(s.abiertos / s.total * 100) + '%' : '—'])) };
  } catch { return null; }
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
    reengagement_enviados: 0,
    wa_por_apertura: 0,
    wa_followup2: 0,
    ab_optimizer: null,
    timing: {},
    errors: []
  };

  const funcStart = Date.now();
  const elapsed = () => Date.now() - funcStart;
  const mark = (k) => { summary.timing[k] = elapsed(); };

  // Kill-switch: garantiza respuesta antes del timeout de Vercel (55s safe margin)
  const killTimer = setTimeout(() => {
    if (!res.headersSent) {
      summary.errors.push({ tipo: 'kill_switch', msg: `Salida forzada a ${elapsed()}ms` });
      res.json({ ok: true, summary });
    }
  }, 55000);

  try {
    // Cargar config
    const cfgRows = await sbGet('rhinos_config?key=in.(vendedor_razon_social,vendedor_servicios,vendedor_tono,vendedor_followup_dias,vendedor_max_dia,vendedor_mensaje_ejemplo,vendedor_website,vendedor_whatsapp,vendedor_nombre_vendedor,vendedor_activo,vendedor_hora_envio,vendedor_dias_envio,vendedor_delay_min,vendedor_delay_max,vendedor_max_followups,vendedor_calendly,vendedor_wa_greenapi_id,vendedor_wa_greenapi_token,vendedor_ab_winner,gmail_email)');
    const cfgMap = {};
    cfgRows.forEach(r => { cfgMap[r.key] = r.value; });

    const force = (req.query || {}).force === '1';
    const activo = cfgMap.vendedor_activo || 'true';

    // Estado del sistema — force=1 bypasea todo (envío manual del usuario)
    if (!force) {
      if (activo === 'false') return res.json({ ok: true, skipped: true, reason: 'sistema pausado — reactivá desde Configuración' });
      if (activo === 'solo_prospecta') return res.json({ ok: true, skipped: true, reason: 'modo solo prospección activo' });
    }

    const horaEnvio = parseInt(cfgMap.vendedor_hora_envio || '9', 10);
    const diasEnvio = (cfgMap.vendedor_dias_envio || '1,2,3,4,5').split(',').map(Number);
    const _now = new Date();
    const horaAR = ((_now.getUTCHours() - 3) + 24) % 24;
    const diaAR  = _now.getUTCDay() || 7; // 0=Dom→7

    // Emails iniciales: corre en las 3 horas desde horaEnvio (ej: 9, 10, 11)
    const canDoInitials = force || ([horaEnvio, horaEnvio+1, horaEnvio+2].includes(horaAR) && diasEnvio.includes(diaAR));
    // Follow-ups: cualquier hora laboral (8am-8pm AR) en días configurados
    const canDoFollowups = force || (diasEnvio.includes(diaAR) && horaAR >= 8 && horaAR <= 20);

    if (!canDoInitials && !canDoFollowups) {
      return res.json({ ok: true, skipped: true, reason: `fuera de horario (${horaAR}:00 AR, días: ${diasEnvio.join(',')})` });
    }

    const cfg = {
      razon_social:      cfgMap.vendedor_razon_social || 'nuestra empresa',
      servicios:         cfgMap.vendedor_servicios    || 'servicios de gestión comercial',
      tono:              cfgMap.vendedor_tono         || 'profesional',
      followup_dias:     parseInt(cfgMap.vendedor_followup_dias || '3', 10),
      max_dia:           parseInt(cfgMap.vendedor_max_dia       || '20', 10),
      mensaje_ejemplo:   cfgMap.vendedor_mensaje_ejemplo || '',
      website:           cfgMap.vendedor_website         || '',
      whatsapp:          cfgMap.vendedor_whatsapp        || '',
      nombre_vendedor:   cfgMap.vendedor_nombre_vendedor || '',
      calendly:          cfgMap.vendedor_calendly        || '',
      delay_min:         parseInt(cfgMap.vendedor_delay_min     || '3',  10),
      delay_max:         parseInt(cfgMap.vendedor_delay_max     || '8',  10),
      max_followups:     parseInt(cfgMap.vendedor_max_followups || '2',  10),
      wa_greenapi_id:    cfgMap.vendedor_wa_greenapi_id    || '',
      wa_greenapi_token: cfgMap.vendedor_wa_greenapi_token || '',
      ab_winner:         cfgMap.vendedor_ab_winner         || null,
      gmail_email:       cfgMap.gmail_email                || 'comercial@rhinosapp.com',
    };

    // ── A/B optimizer: calcular variante ganadora (solo domingos) ────────
    if (new Date().getDay() === 0) {
      summary.ab_optimizer = await optimizarAB();
      if (summary.ab_optimizer?.winner) cfg.ab_winner = summary.ab_optimizer.winner;
    }

    mark('config');
    let token;
    try { token = await getGmailToken(); }
    catch(e) { clearTimeout(killTimer); return res.json({ ok: false, error: 'Gmail: ' + e.message, summary }); }

    mark('token');
    // ── PASO 0: detectar y limpiar rebotes de las últimas 48hs ──────────
    try {
      const bouncedEmails = await checkBounces(token);
      mark('bounces');
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

    // ── SPAM SIGNAL CHECK: auto-pausa si tasa de rebote > 15% esta semana ─
    // Con force=1 (envío manual) se omite para no bloquear pruebas del usuario
    if (!force) try {
      const semana = new Date(Date.now() - 7 * 86400000).toISOString();
      const [contactadosSemana, rebotesSemana] = await Promise.all([
        sbGet(`rhinos_prospectos?select=id&ia_contactado=eq.true&ia_fecha_contacto=gte.${encodeURIComponent(semana)}&limit=500`),
        sbGet(`rhinos_prospectos?select=id&estado=eq.invalido&ia_contactado=eq.true&updated_at=gte.${encodeURIComponent(semana)}&limit=100`),
      ]);
      if (contactadosSemana.length >= 30) {
        const tasaRebote = rebotesSemana.length / contactadosSemana.length;
        if (tasaRebote > 0.35) {
          await sbReq('PATCH', 'rhinos_config?key=eq.vendedor_activo', { value: 'false', updated_at: new Date().toISOString() });
          return res.json({
            ok: true, skipped: true, summary,
            reason: `🚨 Auto-pausado: tasa de rebote ${(tasaRebote * 100).toFixed(0)}% (umbral 35%). Revisá el dominio o limpiá la lista. Reactivá desde Configuración.`,
          });
        }
        if (tasaRebote > 0.15) {
          summary.errors.push({ tipo: 'spam_warning', msg: `⚠️ Rebote ${(tasaRebote * 100).toFixed(0)}% — considerá revisar la calidad de los emails de prospectos.` });
        }
      }
    } catch(e) {
      summary.errors.push({ tipo: 'spam_check', error: e.message });
    }

    mark('paso0');
    // Delays: 1-2s siempre (suficiente para no parecer bot, dentro del límite de Vercel)
    const getDelay = () => Math.round(1000 + Math.random() * 1200);
    // Budgets dentro del kill-switch de 55s (el overhead de config+token+bounces usa ~8s)
    const p1Budget = 22000; // 22s para emails iniciales
    const p2Budget = 44000; // 44s para follow-ups

    let enviados = 0;
    const fromDisplay = [cfg.nombre_vendedor, cfg.razon_social].filter(Boolean).join(' de ');
    const gmailFrom   = cfg.gmail_email;

    // ── PASO 1: contacto inicial (solo en la ventana de horaEnvio) ──────
    if (!canDoInitials) { mark('paso1_skip'); }
    if (canDoInitials) {
    // Cupo diario: cuántos ya se enviaron hoy para no exceder max_dia
    const hoy = new Date().toISOString().slice(0, 10);
    const enviadosHoy = await sbGet(`rhinos_prospectos?select=id&ia_contactado=eq.true&ia_fecha_contacto=gte.${encodeURIComponent(hoy + 'T00:00:00Z')}&limit=${cfg.max_dia + 1}`);
    const cupoHoy = Math.max(0, cfg.max_dia - enviadosHoy.length);
    if (cupoHoy <= 0) { mark('paso1_cupo_lleno'); }
    else {
    // Traemos más de los necesarios para poder deduplicar por empresa
    const enColaRaw = await sbGet(
      `rhinos_prospectos?estado=eq.nuevo&ia_contactado=eq.false&order=created_at.asc&limit=${cupoHoy * 5}`
    );

    // Empresas que ya tienen al menos un contacto previo (cualquier run anterior)
    const yaContactadasRows = await sbGet('rhinos_prospectos?select=empresa&ia_contactado=eq.true&limit=5000');
    const empresasYaContactadas = new Set(yaContactadasRows.map(r => (r.empresa || '').toLowerCase().trim()));

    // Deduplicar: 1 solo email por empresa por run, saltando empresas ya contactadas antes
    const empresasEsteRun = new Set();
    const enCola = enColaRaw.filter(p => {
      const k = (p.empresa || '').toLowerCase().trim();
      if (empresasYaContactadas.has(k)) return false;
      if (empresasEsteRun.has(k)) return false;
      empresasEsteRun.add(k);
      return true;
    }).slice(0, cupoHoy);

    const EMAIL_INVALIDO = /noreply|no-reply|donotreply|example\.com|ejemplo\.|sentry\.|wix\.|wordpress\.|schema\.|googleapis|tuemail@|youremail@|yourmail@|email@email|@email\.com|yourstore\.|yourdomain\.|miempresa\.|tuempresa\.|yoursite\.|mysite\.|info@info\.|test@test\.|demo@|hola@hola\.|contact@contact\.|nombre@|^tu@|returns@|unsubscribe@|bounce@|mailer-daemon@|postmaster@|spam@|abuse@|%[0-9a-f]{2}/i;

    for (const p of enCola) {
      if (enviados >= cupoHoy || elapsed() > p1Budget) break;
      // Anular prospectos con emails falsos/placeholder antes de intentar enviar
      if (!p.email || EMAIL_INVALIDO.test(p.email) || p.email.split('.').pop().length > 10) {
        const now = new Date().toISOString();
        await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, { estado: 'invalido', updated_at: now }).catch(() => {});
        summary.errors.push({ empresa: p.empresa, tipo: 'email_invalido', error: `Email descartado: ${p.email}` });
        continue;
      }
      try {
        const email = await generarEmail(cfg, p, false, null);
        const sent  = await sendGmail(token, p.email, email.asunto, email.cuerpo, p.id, fromDisplay, gmailFrom);
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
      if (elapsed() <= p1Budget) await new Promise(r => setTimeout(r, getDelay()));
    }
    } // fin else cupoHoy
    } // fin if canDoInitials

    mark('paso1');
    // ── PASO 2: follow-ups (cualquier hora laboral en días configurados) ──
    if (!canDoFollowups) { mark('paso2_skip'); }
    else {
    const cutoff = new Date(Date.now() - cfg.followup_dias * 86400000).toISOString();
    const pendientes = await sbGet(
      `rhinos_prospectos?ia_contactado=eq.true&ia_reply=eq.false&ia_followup_count=lt.${cfg.max_followups}&ia_fecha_contacto=lt.${encodeURIComponent(cutoff)}&estado=not.in.(frio,invalido,rechazado,interesado,reengagement)&order=ia_fecha_contacto.asc&limit=30`
    );

    for (const p of pendientes) {
      if (elapsed() > p2Budget) break;
      try {
        const now     = new Date().toISOString();

        // Respetar la pausa de ia_followup_fecha (ej: fuera_oficina programa recontacto futuro)
        if (p.ia_followup_fecha && new Date(p.ia_followup_fecha) > Date.now()) {
          summary.sin_novedad = (summary.sin_novedad || 0) + 1;
          continue;
        }

        const replied = await hasReply(token, p.ia_gmail_thread_id);

        if (replied) {
          // Solo marcar que hay reply — vendedor-replies clasifica la intención
          // y decide si crear lead o marcar como interesado (evita falsos positivos por auto-respuestas)
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, { ia_reply: true, ia_reply_fecha: now, updated_at: now });
          summary.respondieron++;
          continue;
        }

        const email    = await generarEmail(cfg, p, true, { asunto: p.ia_email_asunto, cuerpo: p.ia_email_body }, p.ia_abierto || false);
        const sent     = await sendGmail(token, p.email, email.asunto, email.cuerpo, p.id, fromDisplay, gmailFrom);
        const newCount = (p.ia_followup_count || 0) + 1;
        const estado   = newCount >= cfg.max_followups ? 'frio' : 'follow_up_' + newCount;

        await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
          ia_followup_count: newCount, ia_followup_fecha: now,
          ia_gmail_thread_id: sent.threadId || p.ia_gmail_thread_id,
          estado, updated_at: now,
        });
        if (estado === 'frio') summary.frios++; else summary.followup_enviados++;
      } catch(e) {
        summary.errors.push({ empresa: p.empresa, tipo: 'followup', error: e.message });
      }
      if (elapsed() <= p2Budget) await new Promise(r => setTimeout(r, getDelay()));
    }

    } // fin if canDoFollowups

    mark('paso2');
    // ── PASO 3: re-engagement — prospectos 'frio' de hace 30+ días ──────
    if (!canDoFollowups || elapsed() > 46000) { /* skip si fuera de horario o sin tiempo */ }
    else try {
      const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const frios = await sbGet(
        `rhinos_prospectos?estado=eq.frio&ia_followup_fecha=lt.${encodeURIComponent(cutoff30)}&order=ia_followup_fecha.asc&limit=5`
      );
      for (const p of frios) {
        if (elapsed() > 52000) break;
        try {
          const rubroCtx = getRubroContext(p.rubro);
          const firma    = buildFirma(cfg);
          const link     = cfg.calendly || cfg.website || '';
          const system   = `Sos ${cfg.nombre_vendedor || 'del equipo'} de "${cfg.razon_social}". Le escribiste a esta empresa hace más de 30 días y no hubo respuesta. Es el último intento, con ángulo completamente diferente. Español rioplatense, casual, sin presión.\n\nENFOQUE: NO hagas seguimiento del email anterior. Empezá de cero: mencioná un resultado concreto de una empresa similar, o hacé UNA pregunta directa sobre un problema específico de su industria.\n\nREGLAS:\n- Máximo 50 palabras en el cuerpo (SIN firma)\n- Sin emojis en el asunto\n- Sin "sé que estás ocupado", "solo quería seguir", "última vez que te escribo"\n${link ? '- Un solo link al final: ' + link : ''}\n- Firma exacta:\n${firma}\n\nDevolvé SOLO JSON: {"asunto":"...","cuerpo":"..."}. Cuerpo = texto + \\n\\n + firma. Texto plano.`;
          const userMsg  = `Empresa: ${p.empresa}\nRubro: ${p.rubro || ''} (dolor típico: ${rubroCtx})\nLocalidad: ${p.localidad || ''}`;
          const raw      = await claudeChat(system, userMsg);
          const match    = raw.match(/\{[\s\S]*\}/);
          if (!match) throw new Error('JSON inválido');
          const email    = JSON.parse(match[0]);
          await sendGmail(token, p.email, email.asunto, email.cuerpo, p.id, fromDisplay, gmailFrom);
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
            estado: 'reengagement', ia_followup_count: (p.ia_followup_count || 0) + 1,
            ia_followup_fecha: new Date().toISOString(), updated_at: new Date().toISOString(),
          });
          summary.reengagement_enviados++;
        } catch(e) {
          summary.errors.push({ empresa: p.empresa, tipo: 're-engagement', error: e.message });
        }
        await new Promise(r => setTimeout(r, getDelay()));
      }
    } catch(e) {
      summary.errors.push({ tipo: 'reengagement_check', error: e.message });
    }

    // ── PASO 4: abrieron el email pero no respondieron → trigger WA ─────
    if (canDoFollowups && elapsed() <= 52000 && cfg.wa_greenapi_id && cfg.wa_greenapi_token) {
    try {
      try {
        const abiertos = await sbGet(
          `rhinos_prospectos?ia_abierto=eq.true&ia_reply=eq.false&ia_wa_enviado=eq.false&estado=not.in.(frio,invalido,rechazado,reengagement)&order=ia_ultima_apertura.desc&limit=15`
        );
        for (const p of abiertos) {
          if (!p.telefono) continue;
          const chatId = normalizePhone(p.telefono);
          if (!chatId) continue;
          try {
            const nombre  = cfg.nombre_vendedor || 'el equipo';
            const empresa = cfg.razon_social || 'nuestra empresa';
            const link    = cfg.calendly || cfg.website || '';
            const msg     = `Hola! Soy ${nombre} de ${empresa}.\n\nTe mandé un email sobre cómo podemos ayudar con la gestión de ${p.empresa}. Vi que lo viste pero quizás no tuviste tiempo de responder.\n\n¿Tenés 5 minutos esta semana para que te cuente cómo le funcionó a otras ${p.rubro || 'empresas'} de tu rubro?${link ? '\n\nPodés agendar directo acá: ' + link : ''}`;
            const result  = await sendWhatsAppMsgLocal(cfg.wa_greenapi_id, cfg.wa_greenapi_token, chatId, msg);
            if (result.idMessage) {
              await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
                ia_wa_enviado: true, ia_wa_fecha: new Date().toISOString(),
                ia_wa_msg_id: result.idMessage, updated_at: new Date().toISOString(),
              });
              summary.wa_por_apertura++;
            }
          } catch(e) {
            summary.errors.push({ empresa: p.empresa, tipo: 'wa_apertura', error: e.message });
          }
          await new Promise(r => setTimeout(r, getDelay()));
        }
      } catch(e) {
        summary.errors.push({ tipo: 'wa_apertura_check', error: e.message });
      }

      // ── PASO 5: WA follow-up día 3 — no respondieron al primer WA ────
      try {
        const cutoffWa = new Date(Date.now() - 3 * 86400000).toISOString();
        const waEnviados = await sbGet(
          `rhinos_prospectos?ia_wa_enviado=eq.true&ia_reply=eq.false&ia_wa_fecha=lt.${encodeURIComponent(cutoffWa)}&estado=not.in.(frio,invalido,rechazado)&order=ia_wa_fecha.asc&limit=10`
        );
        for (const p of waEnviados) {
          if (!p.telefono) continue;
          const chatId = normalizePhone(p.telefono);
          if (!chatId) continue;
          // Solo un follow-up WA (evitar spam): si ya tiene ia_wa_2_enviado, skip
          if (p.ia_wa_2_enviado) continue;
          try {
            const nombre  = cfg.nombre_vendedor || 'el equipo';
            const empresa = cfg.razon_social || 'nuestra empresa';
            const link    = cfg.calendly || cfg.website || '';
            const msg     = `Hola de nuevo! Soy ${nombre} de ${empresa}.\n\nQuería saber si llegaste a revisar lo que te mandé. Una ${p.rubro || 'empresa'} de ${p.localidad || 'tu zona'} similar a ${p.empresa} redujo el tiempo de gestión a la mitad con nuestro sistema.\n\n¿Puedo mandarte los detalles?${link ? ' ' + link : ''}`;
            const result  = await sendWhatsAppMsgLocal(cfg.wa_greenapi_id, cfg.wa_greenapi_token, chatId, msg);
            if (result.idMessage) {
              await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
                ia_wa_2_enviado: true, updated_at: new Date().toISOString(),
              }).catch(() => {});
              summary.wa_followup2++;
            }
          } catch(e) {
            summary.errors.push({ empresa: p.empresa, tipo: 'wa_followup2', error: e.message });
          }
          await new Promise(r => setTimeout(r, getDelay()));
        }
      } catch(e) {
        summary.errors.push({ tipo: 'wa_followup2_check', error: e.message });
      }
    } catch(e) {
      summary.errors.push({ tipo: 'wa_check', error: e.message });
    }
    } // fin if canDoFollowups && wa

    mark('done');
    clearTimeout(killTimer);
    return res.json({ ok: true, summary });
  } catch(e) {
    clearTimeout(killTimer);
    return res.status(500).json({ ok: false, error: e.message, summary });
  }
};
