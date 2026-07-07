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
  const rows = await sbGet('rhinos_config?key=in.(vendedor_razon_social,vendedor_servicios,vendedor_tono,vendedor_followup_dias,vendedor_max_dia,vendedor_mensaje_ejemplo,vendedor_website,vendedor_rubro_auto,vendedor_provincias_auto,vendedor_cantidad_auto,vendedor_minimo_auto,vendedor_minimo_busqueda,vendedor_whatsapp,vendedor_nombre_vendedor,vendedor_reply_modo,vendedor_reply_max)');
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
  };
}

function buildFirma(cfg) {
  const lines = ['--'];
  if (cfg.nombre_vendedor) lines.push(cfg.nombre_vendedor);
  lines.push(cfg.razon_social || '');
  if (cfg.whatsapp) lines.push(`💬 WhatsApp: https://wa.me/${cfg.whatsapp}`);
  if (cfg.website)  lines.push(`🌐 ${cfg.website}`);
  return lines.join('\n');
}

async function generarEmail(cfg, prospecto, esFollowup, emailAnterior) {
  const estiloRef = cfg.mensaje_ejemplo
    ? `\n\nESTILO DE REFERENCIA (adaptá este tono y estructura, NO copies el texto):\n"""\n${cfg.mensaje_ejemplo.slice(0, 800)}\n"""`
    : '';
  const websiteLinea = cfg.website ? `\n${cfg.website}` : '';

  const calcLink = 'https://rhinosapp.vercel.app/#calculadora';
  const waLink   = cfg.whatsapp ? `https://wa.me/${cfg.whatsapp}` : null;
  const firma    = buildFirma(cfg);

  const system = esFollowup
    ? `Sos ${cfg.nombre_vendedor || 'del equipo comercial'} de "${cfg.razon_social}". El primer email no tuvo respuesta. Escribí un follow-up en español argentino, tono personal y directo — máximo 80 palabras en el cuerpo (SIN contar la firma). Ángulo diferente al email anterior. CTA único: calculá cuánto podés ahorrar → ${calcLink}. Terminá con esta firma exacta (copiala sin cambiar nada):\n${firma}\nDevolvé SOLO JSON: {"asunto":"...","cuerpo":"..."}. El campo cuerpo incluye texto + firma, separados por doble salto de línea. Texto plano.${estiloRef}`
    : `Sos ${cfg.nombre_vendedor || 'del equipo comercial'} de "${cfg.razon_social}". Servicios: ${cfg.servicios}. Escribí un email comercial en español argentino — tiene que sentirse como enviado a mano a esta empresa, NO como spam masivo. Sé breve, cálido y concreto. Estructura:\n1. Saludo directo con el nombre de la empresa\n2. 2 oraciones conectando el producto con su rubro específico\n3. Lista de 3-4 funcionalidades clave con emojis\n4. Precio: suscripción mensual en pesos, todo incluido, sin sorpresas\n5. CTA destacado (línea sola): "👉 Calculá cuánto podés ahorrar: ${calcLink}"\n6. Firma exacta (copiala sin cambiar nada):\n${firma}\nMáximo 160 palabras en el cuerpo (SIN contar firma). Tono: directo, sin frases genéricas tipo "espero que estén bien" o "me pongo en contacto". Devolvé SOLO JSON: {"asunto":"...","cuerpo":"..."}. Cuerpo incluye texto + firma separados por doble salto de línea. Texto plano.${estiloRef}`;

  const userMsg = esFollowup
    ? `Empresa: ${prospecto.empresa}\nRubro: ${prospecto.rubro || ''}\nLocalidad: ${prospecto.localidad || ''}\nEmail anterior — Asunto: ${emailAnterior.asunto}\nCuerpo: ${emailAnterior.cuerpo}`
    : `Empresa: ${prospecto.empresa}\nContacto: ${prospecto.nombre_contacto || ''}\nRubro: ${prospecto.rubro || ''}\nLocalidad: ${prospecto.localidad || ''}`;

  const raw = await claudeChat(system, userMsg);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude no devolvió JSON válido');
  return JSON.parse(match[0]);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch(e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  let body;
  try { body = await readBody(req); } catch(e) { return res.status(400).json({ error: e.message }); }
  const { action } = body;

  try {
    // ── save_config ──────────────────────────────────────────────────
    if (action === 'save_config') {
      const keys = ['vendedor_razon_social', 'vendedor_servicios', 'vendedor_tono', 'vendedor_followup_dias', 'vendedor_max_dia', 'vendedor_mensaje_ejemplo', 'vendedor_website'];
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
      const { estado, limit = 100, offset = 0 } = body;
      let path = `rhinos_prospectos?order=created_at.desc&limit=${limit}&offset=${offset}`;
      if (estado && estado !== 'todos') path += `&estado=eq.${estado}`;
      return res.json({ ok: true, prospectos: await sbGet(path) });
    }

    // ── get_stats ────────────────────────────────────────────────────
    if (action === 'get_stats') {
      const rows = await sbGet('rhinos_prospectos?select=estado,ia_contactado,ia_reply');
      return res.json({ ok: true, stats: {
        total:       rows.length,
        en_cola:     rows.filter(r => r.estado === 'nuevo').length,
        contactados: rows.filter(r => r.ia_contactado && r.estado !== 'invalido').length,
        replies:     rows.filter(r => r.ia_reply).length,
        interesados: rows.filter(r => r.estado === 'interesado').length,
        frios:       rows.filter(r => r.estado === 'frio').length,
        rebotados:   rows.filter(r => r.estado === 'invalido').length,
      }});
    }

    // ── agregar_pipeline ─────────────────────────────────────────────
    if (action === 'agregar_pipeline') {
      const { prospectos = [] } = body;
      if (!prospectos.length) return res.json({ ok: true, agregados: 0 });
      const now = new Date().toISOString();
      const rows = prospectos.map(p => ({
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
        created_at:      now,
        updated_at:      now,
      }));
      await sbReq('POST', 'rhinos_prospectos', rows);
      return res.json({ ok: true, agregados: rows.length });
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

      for (const p of prospectos) {
        try {
          const email = await generarEmail(cfg, p, false, null);
          const sent = await sendGmail(token, p.email, email.asunto, email.cuerpo);
          const now = new Date().toISOString();
          const id = p.id || (Date.now().toString(36) + Math.random().toString(36).slice(2));
          await sbReq('POST', 'rhinos_prospectos', [{
            id, empresa: p.empresa, nombre_contacto: p.nombre_contacto || '',
            email: p.email, telefono: p.telefono || '', website: p.website || '',
            rubro: p.rubro || '', localidad: p.localidad || '',
            origen: p.origen || 'google_places', estado: 'contactado',
            ia_contactado: true, ia_fecha_contacto: now,
            ia_gmail_thread_id: sent.threadId || null,
            ia_gmail_msg_id: sent.id || null,
            ia_email_asunto: email.asunto, ia_email_body: email.cuerpo,
            ia_followup_count: 0, ia_reply: false,
            created_at: now, updated_at: now
          }]);
          results.push({ empresa: p.empresa, ok: true, asunto: email.asunto });
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
      const pendientes = await sbGet(
        `rhinos_prospectos?ia_contactado=eq.true&ia_reply=eq.false&ia_followup_count=lt.2&ia_fecha_contacto=lt.${encodeURIComponent(cutoff)}&estado=not.in.(frio,invalido)&order=ia_fecha_contacto.asc&limit=30`
      );

      if (!pendientes.length) return res.json({ ok: true, procesados: 0, results: [] });

      const token = await getGmailToken();
      const results = [];

      for (const p of pendientes) {
        try {
          const now = new Date().toISOString();
          const replied = await hasReply(token, p.ia_gmail_thread_id);

          if (replied) {
            await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, { ia_reply: true, ia_reply_fecha: now, estado: 'interesado', updated_at: now });
            results.push({ empresa: p.empresa, accion: 'respondio', estado: 'interesado' });
            continue;
          }

          const email = await generarEmail(cfg, p, true, { asunto: p.ia_email_asunto, cuerpo: p.ia_email_body });
          const sent = await sendGmail(token, p.email, email.asunto, email.cuerpo);
          const newCount = (p.ia_followup_count || 0) + 1;
          const nuevoEstado = newCount >= 2 ? 'frio' : 'follow_up_' + newCount;

          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
            ia_followup_count: newCount, ia_followup_fecha: now,
            ia_gmail_thread_id: sent.threadId || p.ia_gmail_thread_id,
            estado: nuevoEstado, updated_at: now
          });
          results.push({ empresa: p.empresa, accion: 'followup_enviado', followup_n: newCount, estado: nuevoEstado });
        } catch(e) {
          results.push({ empresa: p.empresa, accion: 'error', error: e.message });
        }
        await new Promise(r => setTimeout(r, 600));
      }
      return res.json({ ok: true, procesados: results.length, results });
    }

    return res.status(400).json({ error: 'Acción desconocida: ' + action });
  } catch(e) {
    console.error('[vendedor]', action, e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
