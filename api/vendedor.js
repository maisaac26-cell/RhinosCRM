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
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw || null); } });
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
  if (!map.gmail_refresh_token) throw new Error('Gmail no conectado. Conectá tu cuenta Gmail en el CRM primero.');

  const expired = !map.gmail_token_expiry || new Date(map.gmail_token_expiry) < new Date(Date.now() + 60000);
  if (!expired && map.gmail_access_token) return map.gmail_access_token;

  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  const rPayload = new URLSearchParams({
    refresh_token: map.gmail_refresh_token, client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, grant_type: 'refresh_token'
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
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(upd), 'Prefer': 'resolution=merge-duplicates,return=minimal' }
  }, () => {}).end(upd);
  return refreshed.access_token;
}

function buildMultipartRaw(to, subject, textBody, prospId, fromDisplay, gmailFrom) {
  const boundary = 'MP' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const subj64 = '=?UTF-8?B?' + Buffer.from(subject || '').toString('base64') + '?=';

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

async function hasReply(token, threadId) {
  if (!threadId) return false;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path: `/gmail/v1/users/me/threads/${threadId}?format=minimal`,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve((JSON.parse(raw).messages || []).length > 1); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false)); req.end();
  });
}

async function claudeChat(systemPrompt, userMsg) {
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw).content?.[0]?.text || ''); } catch { reject(new Error('Claude API error')); }
      });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

async function getConfig() {
  const rows = await sbGet('rhinos_config?key=in.(vendedor_razon_social,vendedor_servicios,vendedor_tono,vendedor_followup_dias,vendedor_max_dia,vendedor_mensaje_ejemplo,vendedor_website,vendedor_rubro_auto,vendedor_provincias_auto,vendedor_cantidad_auto,vendedor_minimo_auto,vendedor_minimo_busqueda,vendedor_whatsapp,vendedor_nombre_vendedor,vendedor_reply_modo,vendedor_reply_max,vendedor_fuente_auto,vendedor_activo,vendedor_hora_envio,vendedor_dias_envio,vendedor_hora_prospecta,vendedor_delay_min,vendedor_delay_max,vendedor_max_followups,vendedor_calendly,vendedor_wa_greenapi_id,vendedor_wa_greenapi_token,vendedor_wa_dias,vendedor_ab_winner)');
  const map = {};
  rows.forEach(r => { map[r.key] = r.value; });
  return {
    razon_social:     map.vendedor_razon_social || 'nuestra empresa',
    servicios:        map.vendedor_servicios    || 'servicios de gestión comercial',
    tono:             map.vendedor_tono         || 'profesional',
    followup_dias:    parseInt(map.vendedor_followup_dias || '3', 10),
    max_dia:          parseInt(map.vendedor_max_dia       || '20', 10),
    mensaje_ejemplo:  map.vendedor_mensaje_ejemplo || '',
    website:          map.vendedor_website || '',
    rubro_auto:        map.vendedor_rubro_auto        || '',
    provincias_auto:   map.vendedor_provincias_auto   || '',
    cantidad_auto:     parseInt(map.vendedor_cantidad_auto || '20', 10),
    minimo_auto:       parseInt(map.vendedor_minimo_auto      || '10', 10),
    minimo_busqueda:   parseInt(map.vendedor_minimo_busqueda  || '2',  10),
    whatsapp:          map.vendedor_whatsapp          || '',
    nombre_vendedor:   map.vendedor_nombre_vendedor   || '',
    reply_modo:        map.vendedor_reply_modo        || 'draft',
    reply_max:         parseInt(map.vendedor_reply_max || '5', 10),
    fuente_auto:       map.vendedor_fuente_auto       || 'google',
    activo:            map.vendedor_activo || 'true',
    hora_envio:        parseInt(map.vendedor_hora_envio    || '12', 10),
    dias_envio:        map.vendedor_dias_envio             || '1,2,3,4,5',
    hora_prospecta:    parseInt(map.vendedor_hora_prospecta || '21', 10),
    delay_min:         parseInt(map.vendedor_delay_min      || '3',  10),
    delay_max:         parseInt(map.vendedor_delay_max      || '8',  10),
    max_followups:     parseInt(map.vendedor_max_followups  || '2',  10),
    calendly:          map.vendedor_calendly                || '',
    wa_greenapi_id:    map.vendedor_wa_greenapi_id          || '',
    wa_greenapi_token: map.vendedor_wa_greenapi_token       || '',
    wa_dias:           parseInt(map.vendedor_wa_dias        || '4',  10),
    ab_winner:         map.vendedor_ab_winner               || null,
    gmail_email:       map.gmail_email                      || 'comercial@rhinosapp.com',
  };
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

async function generarEmail(cfg, prospecto, esFollowup, emailAnterior) {
  const ejemploLimpio = cfg.mensaje_ejemplo || '';
  const esEjemploSpam = (ejemploLimpio.match(/[📦🛒💳🧾📊📱✅❌🎯🦏👉]/gu) || []).length > 2
    || (ejemploLimpio.match(/^[•\-\*]/gm) || []).length > 2;
  const estiloRef = (!esEjemploSpam && ejemploLimpio.length > 20)
    ? `\n\nTONO DE REFERENCIA (solo el tono):\n"""\n${ejemploLimpio.slice(0, 300)}\n"""`
    : '';

  const calcLink = cfg.calendly || 'https://rhinosapp.vercel.app/#calculadora';
  const firma    = buildFirma(cfg);
  const rubroCtx = getRubroContext(prospecto.rubro);

  const PALABRAS_SPAM = '"oferta", "precio", "suscripción", "calculá", "ahorrar", "ahorro", "gratis", "garantía", "descuento", "exclusivo", "urgente", "oportunidad", "limitado", "tiempo limitado", "actúa ahora", "hacé clic", "click aquí", "100%", "beneficio", "rentabilidad", "sin costo", "sin cargo", "probá gratis"';
  const system = esFollowup
    ? `Sos ${cfg.nombre_vendedor || 'del equipo'} de "${cfg.razon_social}". Le escribiste a esta empresa y no respondió. Escribí un segundo contacto brevísimo en español rioplatense.\n\nREGLAS ABSOLUTAS:\n- Máximo 40 palabras en el cuerpo (SIN firma)\n- Cero emojis en asunto ni cuerpo\n- NO menciones el email anterior — empezá de cero\n- CERO links — no incluyas ningún link\n- UNA sola pregunta concreta sobre su industria\n- Sin ${PALABRAS_SPAM}\n- Sin "hacemos seguimiento", "te quería recordar"\n- Asunto: máximo 40 caracteres, sin signos de exclamación\n- Firma exacta sin modificar:\n${firma}\n\nDevolvé SOLO JSON: {"asunto":"...","cuerpo":"..."}. Cuerpo = texto + \\n\\n + firma. Texto plano sin markdown.${estiloRef}`
    : `Sos ${cfg.nombre_vendedor || 'del equipo'} de "${cfg.razon_social}" — sistema de gestión para PyMEs argentinas (${(cfg.servicios || '').slice(0, 120).split('\n')[0]}).\n\nMISIÓN: Email que llegue a la bandeja principal (no Spam ni Promociones) y que el dueño quiera responder. Persona a persona, no campaña masiva.\n\nPERSONALIZACIÓN OBLIGATORIA:\n- Si recibís "Datos reales" (rating Maps, reseñas), usálo en la primera oración.\n- El "dolor típico" del rubro es lo que el dueño siente todos los días — conectalo con la solución.\n\nREGLAS DE ENTREGABILIDAD (cada violación aumenta el score de spam):\n- CUERPO: máximo 65 palabras (sin firma)\n- ASUNTO: máximo 50 caracteres, sin emojis, sin exclamación, sin mayúsculas seguidas\n- Cero bullets ni listas\n- UN SOLO link, dentro de una oración natural: ${calcLink}\n- Cero palabras spam: ${PALABRAS_SPAM}\n- Cero frases corporativas: "espero que estén bien", "me dirijo a ustedes"\n- Cero presión ni urgencia\n- Tono: conversacional, como si le escribieras a un conocido\n\nESTRUCTURA (3 oraciones máx):\n1. Observación concreta del negocio (dato real Maps, o rubro + localidad)\n2. Problema de esa industria + cómo "${cfg.razon_social}" lo resuelve\n3. Llamado a la acción con el link integrado\n[doble salto]\n[Firma exacta, no la modifiques:]\n${firma}\n\nASUNTO — 3 variantes:\nasunto_a: nombre empresa + tema del rubro (ej: "Farmacia Del Sol — vencimientos y stock")\nasunto_b: mini-pregunta específica del negocio (ej: "¿Cómo manejan los pedidos en Farmacia Del Sol?")\nasunto_c: cortísimo, 2-4 palabras con nombre de empresa (ej: "Para Farmacia Del Sol")\n\nDevolvé SOLO JSON válido: {"asunto_a":"...","asunto_b":"...","asunto_c":"...","cuerpo":"..."}. Cuerpo = texto + \\n\\n + firma. Texto plano, sin markdown.${estiloRef}`;

  const userMsg = esFollowup
    ? `Empresa: ${prospecto.empresa}\nRubro: ${prospecto.rubro || ''} (dolor típico: ${rubroCtx})\nLocalidad: ${prospecto.localidad || ''}\nEmail anterior — Asunto: ${emailAnterior.asunto}\nCuerpo: ${emailAnterior.cuerpo}`
    : `Empresa: ${prospecto.empresa}\nContacto: ${prospecto.nombre_contacto || ''}\nRubro: ${prospecto.rubro || ''} (dolor típico: ${rubroCtx})\nLocalidad: ${prospecto.localidad || ''}${prospecto.notas ? '\nDatos reales: ' + prospecto.notas : ''}`;

  const raw = await claudeChat(system, userMsg);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude no devolvió JSON válido');
  const parsed = JSON.parse(match[0]);

  if (!esFollowup && parsed.asunto_a) {
    let v;
    const winner = cfg.ab_winner;
    if (winner && ['a','b','c'].includes(winner) && Math.random() < 0.7) {
      v = winner; // 70% usar winner, 30% explorar
    } else {
      v = ['a','b','c'][Math.floor(Math.random() * 3)];
    }
    return { asunto: parsed[`asunto_${v}`] || parsed.asunto_a, cuerpo: parsed.cuerpo, variant: v };
  }
  return { asunto: parsed.asunto || '', cuerpo: parsed.cuerpo, variant: null };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch(e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ── WhatsApp via Green API (antes en vendedor-whatsapp.js) ────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('54')) p = '54' + p;
  if (p.length < 10 || p.length > 15) return null;
  return p + '@c.us';
}

function sendWhatsAppMsg(instanceId, token, chatId, message) {
  const payload = JSON.stringify({ chatId, message });
  return new Promise((resolve) => {
    const req = https.request({ hostname: 'api.green-api.com', path: `/waInstance${instanceId}/sendMessage/${token}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({ error: 'network' }));
    req.write(payload); req.end();
  });
}

async function handleSendWhatsApp(req, res) {
  const summary = { enviados: 0, sin_telefono: 0, ya_enviado: 0, errores: [] };
  try {
    const cfgRows = await sbGet('rhinos_config?key=in.(vendedor_razon_social,vendedor_nombre_vendedor,vendedor_website,vendedor_calendly,vendedor_wa_greenapi_id,vendedor_wa_greenapi_token,vendedor_wa_dias,vendedor_activo)');
    const cfgMap = {}; cfgRows.forEach(r => { cfgMap[r.key] = r.value; });
    const force = ((req.query || {}).force === '1');
    if (!force && (cfgMap.vendedor_activo || 'true') === 'false') return res.json({ ok: true, skipped: true, reason: 'sistema pausado' });
    const instanceId = cfgMap.vendedor_wa_greenapi_id || '';
    const token = cfgMap.vendedor_wa_greenapi_token || '';
    if (!instanceId || !token) return res.json({ ok: false, error: 'Green API no configurada' });
    const cfg = { razon_social: cfgMap.vendedor_razon_social || '', nombre_vendedor: cfgMap.vendedor_nombre_vendedor || '', website: cfgMap.vendedor_website || '', calendly: cfgMap.vendedor_calendly || '', wa_dias: parseInt(cfgMap.vendedor_wa_dias || '4', 10) };
    const cutoff = new Date(Date.now() - cfg.wa_dias * 86400000).toISOString();
    const pendientes = await sbGet(`rhinos_prospectos?ia_contactado=eq.true&ia_reply=eq.false&ia_wa_enviado=eq.false&ia_fecha_contacto=lt.${encodeURIComponent(cutoff)}&estado=not.in.(frio,invalido)&order=ia_score.desc.nullslast&limit=30`);
    for (const p of pendientes) {
      const chatId = normalizePhone(p.telefono);
      if (!chatId) { summary.sin_telefono++; continue; }
      try {
        const nombre = cfg.nombre_vendedor || 'el equipo';
        const empresa = cfg.razon_social || 'nuestra empresa';
        const link = cfg.calendly || cfg.website || '';
        const msg = `Hola! Soy ${nombre} de ${empresa}.\n\nTe escribí un mail hace unos días sobre cómo podemos ayudar con la gestión de ${p.empresa}. ¿Lo viste?\n\nSi preferís, te cuento en 5 minutos.${link ? ' Te dejo el link: ' + link : ''}`;
        const result = await sendWhatsAppMsg(instanceId, token, chatId, msg);
        const now = new Date().toISOString();
        if (result.idMessage) {
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, { ia_wa_enviado: true, ia_wa_fecha: now, ia_wa_msg_id: result.idMessage, updated_at: now });
          summary.enviados++;
        } else { summary.errores.push({ empresa: p.empresa, error: JSON.stringify(result) }); }
      } catch(e) { summary.errores.push({ empresa: p.empresa, error: e.message }); }
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
    }
    return res.json({ ok: true, summary });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message, summary }); }
}

// Tracking pixel (antes en vendedor-track.js) — GET /api/vendedor?action=track&id=XXX
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Tracking pixel — responde imagen y registra apertura en background
  const qa = req.query || {};
  if (qa.action === 'track') {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.end(PIXEL);
    const id = qa.id;
    if (id) {
      const now = new Date().toISOString();
      const b1 = JSON.stringify({ ia_abierto: true, ia_ultima_apertura: now, ia_apertura_count: 1, updated_at: now });
      const r1 = https.request({ hostname: new URL(SB_URL).hostname, path: `/rest/v1/rhinos_prospectos?id=eq.${encodeURIComponent(id)}&ia_abierto=eq.false`, method: 'PATCH', headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b1), 'Prefer': 'return=minimal' } }, () => {});
      r1.on('error', () => {}); r1.write(b1); r1.end();
      const b2 = JSON.stringify({ ia_ultima_apertura: now, updated_at: now });
      const r2 = https.request({ hostname: new URL(SB_URL).hostname, path: `/rest/v1/rhinos_prospectos?id=eq.${encodeURIComponent(id)}&ia_abierto=eq.true`, method: 'PATCH', headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b2), 'Prefer': 'return=minimal' } }, () => {});
      r2.on('error', () => {}); r2.write(b2); r2.end();
    }
    return;
  }

  // WhatsApp cron (antes en vendedor-whatsapp.js) — GET /api/vendedor?action=send_whatsapp
  if (qa.action === 'send_whatsapp') {
    res.setHeader('Content-Type', 'application/json');
    return handleSendWhatsApp(req, res);
  }

  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  let body;
  try { body = await readBody(req); } catch(e) { return res.status(400).json({ error: e.message }); }
  const { action } = body;

  try {
    // ── save_config ──────────────────────────────────────────────────
    if (action === 'save_config') {
      const keys = [
        'vendedor_razon_social', 'vendedor_servicios', 'vendedor_tono', 'vendedor_followup_dias',
        'vendedor_max_dia', 'vendedor_mensaje_ejemplo', 'vendedor_website',
        'vendedor_rubro_auto', 'vendedor_provincias_auto', 'vendedor_cantidad_auto',
        'vendedor_minimo_auto', 'vendedor_minimo_busqueda', 'vendedor_whatsapp',
        'vendedor_nombre_vendedor', 'vendedor_reply_modo', 'vendedor_reply_max', 'vendedor_fuente_auto',
        'vendedor_activo', 'vendedor_hora_envio', 'vendedor_dias_envio', 'vendedor_hora_prospecta',
        'vendedor_delay_min', 'vendedor_delay_max', 'vendedor_max_followups',
        'vendedor_calendly', 'vendedor_wa_greenapi_id', 'vendedor_wa_greenapi_token', 'vendedor_wa_dias',
      ];
      const rows = keys.filter(k => body[k] !== undefined).map(k => ({ key: k, value: String(body[k]), updated_at: new Date().toISOString() }));
      if (rows.length) await sbReq('POST', 'rhinos_config', rows);
      return res.json({ ok: true });
    }

    // ── get_config ───────────────────────────────────────────────────
    if (action === 'get_config') {
      return res.json({ ok: true, config: await getConfig() });
    }

    // ── get_prospectos ───────────────────────────────────────────────
    if (action === 'get_prospectos') {
      const { estado, limit = 50, offset = 0 } = body;
      let path = `rhinos_prospectos?order=created_at.desc&limit=${limit + 1}&offset=${offset}`;
      if (estado === 'abrieron') path += `&ia_abierto=eq.true`;
      else if (estado && estado !== 'todos') path += `&estado=eq.${estado}`;
      const rows = await sbGet(path);
      const hasMore = rows.length > limit;
      return res.json({ ok: true, prospectos: rows.slice(0, limit), hasMore });
    }

    // ── get_daily_stats ──────────────────────────────────────────────
    if (action === 'get_daily_stats') {
      const today = new Date().toISOString().slice(0, 10);
      const [rows, fuRows] = await Promise.all([
        sbGet('rhinos_prospectos?select=ia_fecha_contacto,ia_abierto,ia_reply&ia_contactado=eq.true&ia_fecha_contacto=not.is.null&order=ia_fecha_contacto.desc&limit=2000'),
        sbGet('rhinos_prospectos?select=ia_followup_fecha,ia_followup_count&ia_contactado=eq.true&ia_followup_fecha=not.is.null&limit=2000'),
      ]);
      const byDay = {};
      for (const r of rows) {
        const dia = (r.ia_fecha_contacto || '').slice(0, 10);
        if (!dia || dia > today) continue; // ignorar fechas futuras (fuera_oficina corrupto, etc.)
        if (!byDay[dia]) byDay[dia] = { dia, enviados: 0, followups: 0, abiertos: 0, respondieron: 0 };
        byDay[dia].enviados++;
        if (r.ia_abierto) byDay[dia].abiertos++;
        if (r.ia_reply) byDay[dia].respondieron++;
      }
      for (const r of fuRows) {
        const dia = (r.ia_followup_fecha || '').slice(0, 10);
        if (!dia || dia > today) continue;
        if (!byDay[dia]) byDay[dia] = { dia, enviados: 0, followups: 0, abiertos: 0, respondieron: 0 };
        byDay[dia].followups += (r.ia_followup_count || 1); // sumamos los follow-ups de ese día
      }
      const daily = Object.values(byDay).sort((a, b) => b.dia.localeCompare(a.dia)).slice(0, 30);
      return res.json({ ok: true, daily });
    }

    // ── get_daily_prospecta ──────────────────────────────────────────
    if (action === 'get_daily_prospecta') {
      const rows = await sbGet('rhinos_prospectos?select=created_at&order=created_at.desc&limit=5000');
      const byDay = {};
      for (const r of rows) {
        const dia = (r.created_at || '').slice(0, 10);
        if (!dia) continue;
        byDay[dia] = (byDay[dia] || 0) + 1;
      }
      const daily = Object.entries(byDay)
        .map(([dia, cantidad]) => ({ dia, cantidad }))
        .sort((a, b) => b.dia.localeCompare(a.dia))
        .slice(0, 30);
      return res.json({ ok: true, daily });
    }

    // ── get_stats ────────────────────────────────────────────────────
    if (action === 'get_stats') {
      const [rows, leadsRows, cfgAB] = await Promise.all([
        sbGet('rhinos_prospectos?select=estado,ia_contactado,ia_reply,ia_abierto,ia_subject_variant,ia_wa_enviado,ia_score'),
        sbGet(`rhinos_leads?select=id&source=eq.${encodeURIComponent('Vendedor IA')}`),
        sbGet('rhinos_config?key=eq.vendedor_ab_winner&select=value'),
      ]);
      const abiertos = rows.filter(r => r.ia_abierto);
      return res.json({ ok: true, stats: {
        total:       rows.length,
        en_cola:     rows.filter(r => r.estado === 'nuevo').length,
        contactados: rows.filter(r => r.ia_contactado && r.estado !== 'invalido').length,
        replies:     rows.filter(r => r.ia_reply).length,
        interesados: rows.filter(r => r.estado === 'interesado').length,
        frios:       rows.filter(r => r.estado === 'frio').length,
        rebotados:   rows.filter(r => r.estado === 'invalido').length,
        abiertos:    abiertos.length,
        wa_enviados: rows.filter(r => r.ia_wa_enviado).length,
        score_alto:  rows.filter(r => (r.ia_score || 0) >= 60).length,
        leads:       leadsRows.length,
        ab_winner:   cfgAB[0]?.value || null,
        ab_stats: {
          a: rows.filter(r => r.ia_subject_variant === 'a').length,
          b: rows.filter(r => r.ia_subject_variant === 'b').length,
          c: rows.filter(r => r.ia_subject_variant === 'c').length,
        },
      }});
    }

    // ── agregar_pipeline ─────────────────────────────────────────────
    if (action === 'agregar_pipeline') {
      const { prospectos = [] } = body;
      if (!prospectos.length) return res.json({ ok: true, agregados: 0 });

      // Blacklist check (no crítico si la tabla no existe)
      let blacklistDomains = new Set();
      let blacklistEmpresas = [];
      try {
        const bl = await sbGet('rhinos_blacklist?select=dominio,empresa&limit=500');
        bl.forEach(r => {
          if (r.dominio) blacklistDomains.add(r.dominio.toLowerCase().trim());
          if (r.empresa) blacklistEmpresas.push(r.empresa.toLowerCase().trim());
        });
      } catch {}

      const now = new Date().toISOString();
      const prospectosFiltrados = prospectos.filter(p => {
        const domain = (p.email || '').toLowerCase().split('@')[1] || '';
        if (blacklistDomains.has(domain)) return false;
        const empresaNorm = (p.empresa || '').toLowerCase();
        if (blacklistEmpresas.some(bl => empresaNorm.includes(bl))) return false;
        return true;
      });
      if (!prospectosFiltrados.length) return res.json({ ok: true, agregados: 0, filtrados: prospectos.length });

      const rows = prospectosFiltrados.map(p => ({
        id:              p.id || (Date.now().toString(36) + Math.random().toString(36).slice(2)),
        empresa:         p.empresa,
        nombre_contacto: p.nombre_contacto || '',
        email:           p.email,
        telefono:        p.telefono || '',
        website:         p.website || '',
        rubro:           p.rubro || '',
        localidad:       p.localidad || '',
        origen:          p.origen || 'google_places',
        estado:          'nuevo',
        ia_contactado:   false,
        ia_followup_count: 0,
        ia_reply:        false,
        ia_wa_enviado:   false,
        created_at:      now,
        updated_at:      now,
      }));
      await sbReq('POST', 'rhinos_prospectos', rows);
      return res.json({ ok: true, agregados: rows.length, filtrados: prospectos.length - prospectosFiltrados.length });
    }

    // ── update_prospecto ─────────────────────────────────────────────
    if (action === 'update_prospecto') {
      const { id, ...fields } = body;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      delete fields.action;
      await sbReq('PATCH', `rhinos_prospectos?id=eq.${encodeURIComponent(id)}`, { ...fields, updated_at: new Date().toISOString() });
      return res.json({ ok: true });
    }

    // ── delete_prospecto ─────────────────────────────────────────────
    if (action === 'delete_prospecto') {
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      await sbReq('DELETE', `rhinos_prospectos?id=eq.${encodeURIComponent(id)}`, null);
      return res.json({ ok: true });
    }

    // ── contactar_lote ───────────────────────────────────────────────
    if (action === 'contactar_lote') {
      const { prospectos = [] } = body;
      if (!prospectos.length) return res.json({ ok: true, results: [] });

      const [cfg, token] = await Promise.all([getConfig(), getGmailToken()]);
      const results = [];
      const fromDisplay = [cfg.nombre_vendedor, cfg.razon_social].filter(Boolean).join(' de ');
      const gmailFrom   = cfg.gmail_email || '';

      for (const p of prospectos) {
        try {
          const id = p.id || (Date.now().toString(36) + Math.random().toString(36).slice(2));
          const email = await generarEmail(cfg, p, false, null);
          const sent = await sendGmail(token, p.email, email.asunto, email.cuerpo, null, fromDisplay, gmailFrom);
          const now = new Date().toISOString();
          await sbReq('POST', 'rhinos_prospectos', [{
            id, empresa: p.empresa, nombre_contacto: p.nombre_contacto || '',
            email: p.email, telefono: p.telefono || '', website: p.website || '',
            rubro: p.rubro || '', localidad: p.localidad || '',
            origen: p.origen || 'google_places', estado: 'contactado',
            ia_contactado: true, ia_fecha_contacto: now,
            ia_gmail_thread_id: sent.threadId || null,
            ia_gmail_msg_id: sent.id || null,
            ia_email_asunto: email.asunto, ia_email_body: email.cuerpo,
            ia_subject_variant: email.variant || null,
            ia_followup_count: 0, ia_reply: false,
            created_at: now, updated_at: now
          }]);
          results.push({ empresa: p.empresa, ok: true, asunto: email.asunto, variant: email.variant });
        } catch(e) {
          results.push({ empresa: p.empresa, ok: false, error: e.message });
        }
        await new Promise(r => setTimeout(r, 600));
      }
      return res.json({ ok: true, results });
    }

    // ── run_followups ────────────────────────────────────────────────
    if (action === 'run_followups') {
      const cfg = await getConfig();
      const cutoff = new Date(Date.now() - cfg.followup_dias * 86400000).toISOString();
      const maxFu = cfg.max_followups || 2;
      const pendientes = await sbGet(
        `rhinos_prospectos?ia_contactado=eq.true&ia_reply=eq.false&ia_followup_count=lt.${maxFu}&ia_fecha_contacto=lt.${encodeURIComponent(cutoff)}&estado=not.in.(frio,invalido)&order=ia_fecha_contacto.asc&limit=30`
      );

      if (!pendientes.length) return res.json({ ok: true, procesados: 0, results: [] });

      const token = await getGmailToken();
      const results = [];
      const delayMs = (cfg.delay_min || 3) * 1000;
      const fromDisplayFu = [cfg.nombre_vendedor, cfg.razon_social].filter(Boolean).join(' de ');
      const gmailFromFu   = cfg.gmail_email || '';

      for (const p of pendientes) {
        try {
          const now = new Date().toISOString();
          const replied = await hasReply(token, p.ia_gmail_thread_id);

          if (replied) {
            await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, { ia_reply: true, ia_reply_fecha: now, estado: 'interesado', updated_at: now });
            await crearLeadSiNoExiste(p);
            results.push({ empresa: p.empresa, accion: 'respondio', estado: 'interesado' });
            continue;
          }

          const email = await generarEmail(cfg, p, true, { asunto: p.ia_email_asunto, cuerpo: p.ia_email_body });
          const sent = await sendGmail(token, p.email, email.asunto, email.cuerpo, null, fromDisplayFu, gmailFromFu);
          const newCount = (p.ia_followup_count || 0) + 1;
          const nuevoEstado = newCount >= maxFu ? 'frio' : 'follow_up_' + newCount;

          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
            ia_followup_count: newCount, ia_followup_fecha: now,
            ia_gmail_thread_id: sent.threadId || p.ia_gmail_thread_id,
            estado: nuevoEstado, updated_at: now
          });
          results.push({ empresa: p.empresa, accion: 'followup_enviado', followup_n: newCount, estado: nuevoEstado });
        } catch(e) {
          results.push({ empresa: p.empresa, accion: 'error', error: e.message });
        }
        await new Promise(r => setTimeout(r, delayMs));
      }
      return res.json({ ok: true, procesados: results.length, results });
    }

    return res.status(400).json({ error: 'Acción desconocida: ' + action });
  } catch(e) {
    console.error('[vendedor]', action, e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
