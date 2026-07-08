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

async function sbGet(path) {
  const r = await sbReq('GET', path);
  return Array.isArray(r) ? r : [];
}

function normalizePhone(phone) {
  if (!phone) return null;
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('54')) p = '54' + p;
  if (p.length < 10 || p.length > 15) return null;
  return p + '@c.us';
}

async function sendWhatsApp(instanceId, token, chatId, message) {
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
    req.on('error', () => resolve({ error: 'network' }));
    req.write(payload); req.end();
  });
}

function buildWAMessage(cfg, prospecto) {
  const nombre = cfg.nombre_vendedor || 'el equipo';
  const empresa = cfg.razon_social || 'nuestra empresa';
  const link = cfg.calendly || cfg.website || '';
  return `Hola! Soy ${nombre} de ${empresa}.\n\nTe escribí un mail hace unos días sobre cómo podemos ayudar con la gestión de ${prospecto.empresa}. ¿Lo viste?\n\nSi preferís, te cuento en 5 minutos.${link ? ' Te dejo el link: ' + link : ''}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const summary = { enviados: 0, sin_telefono: 0, ya_enviado: 0, errores: [] };

  try {
    const cfgRows = await sbGet('rhinos_config?key=in.(vendedor_razon_social,vendedor_nombre_vendedor,vendedor_website,vendedor_calendly,vendedor_wa_greenapi_id,vendedor_wa_greenapi_token,vendedor_wa_dias,vendedor_activo)');
    const cfgMap = {};
    cfgRows.forEach(r => { cfgMap[r.key] = r.value; });

    const force = (req.query || {}).force === '1';
    if (!force) {
      const activo = cfgMap.vendedor_activo || 'true';
      if (activo === 'false') return res.json({ ok: true, skipped: true, reason: 'sistema pausado' });
    }

    const instanceId = cfgMap.vendedor_wa_greenapi_id || '';
    const token      = cfgMap.vendedor_wa_greenapi_token || '';
    if (!instanceId || !token) return res.json({ ok: false, error: 'Green API no configurada. Agregá instanceId y token en Configuración.' });

    const cfg = {
      razon_social:  cfgMap.vendedor_razon_social  || '',
      nombre_vendedor: cfgMap.vendedor_nombre_vendedor || '',
      website:       cfgMap.vendedor_website        || '',
      calendly:      cfgMap.vendedor_calendly       || '',
      wa_dias:       parseInt(cfgMap.vendedor_wa_dias || '4', 10),
    };

    const cutoff = new Date(Date.now() - cfg.wa_dias * 86400000).toISOString();
    const pendientes = await sbGet(
      `rhinos_prospectos?ia_contactado=eq.true&ia_reply=eq.false&ia_wa_enviado=eq.false&ia_fecha_contacto=lt.${encodeURIComponent(cutoff)}&estado=not.in.(frio,invalido)&order=ia_score.desc.nullslast&limit=30`
    );

    for (const p of pendientes) {
      const chatId = normalizePhone(p.telefono);
      if (!chatId) { summary.sin_telefono++; continue; }

      try {
        const msg = buildWAMessage(cfg, p);
        const result = await sendWhatsApp(instanceId, token, chatId, msg);
        const now = new Date().toISOString();
        if (result.idMessage) {
          await sbReq('PATCH', `rhinos_prospectos?id=eq.${p.id}`, {
            ia_wa_enviado: true,
            ia_wa_fecha:   now,
            ia_wa_msg_id:  result.idMessage,
            updated_at:    now,
          });
          summary.enviados++;
        } else {
          summary.errores.push({ empresa: p.empresa, error: JSON.stringify(result) });
        }
      } catch(e) {
        summary.errores.push({ empresa: p.empresa, error: e.message });
      }
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
    }

    return res.json({ ok: true, summary });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message, summary });
  }
};
