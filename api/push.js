const webpush = require('web-push');
const https   = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL   = 'mailto:' + (process.env.JIRA_EMAIL || 'ramiroisaacarg@gmail.com');

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

async function sbReq(path, method = 'GET', body = null) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const headers = {
      'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json', 'Prefer': 'return=representation'
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({
      hostname: new URL(SB_URL).hostname,
      path: '/rest/v1/' + path, method, headers
    }, res => {
      let r = ''; res.on('data', c => r += c);
      res.on('end', () => { try { resolve(JSON.parse(r)); } catch(e) { resolve(null); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { action, subscription, title, body, url, tag } = req.body || {};

  // ── Devolver clave pública VAPID (para que el frontend la use al suscribirse)
  if (req.method === 'GET' || action === 'vapid_key') {
    return res.json({ publicKey: VAPID_PUBLIC });
  }

  // ── Guardar suscripción del navegador en Supabase
  if (action === 'subscribe') {
    if (!subscription) return res.status(400).json({ error: 'Falta subscription' });
    const endpoint = subscription.endpoint;
    // Upsert por endpoint para no duplicar
    const existing = await sbReq(`rhinos_push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`);
    if (Array.isArray(existing) && existing.length) {
      await sbReq(`rhinos_push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`, 'PATCH', {
        sub_data: subscription, updated_at: new Date().toISOString()
      });
    } else {
      await sbReq('rhinos_push_subs', 'POST', {
        endpoint, sub_data: subscription, created_at: new Date().toISOString()
      });
    }
    return res.json({ ok: true });
  }

  // ── Eliminar suscripción
  if (action === 'unsubscribe') {
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Falta endpoint' });
    await sbReq(`rhinos_push_subs?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, 'DELETE');
    return res.json({ ok: true });
  }

  // ── Enviar push a todos los suscriptores
  if (action === 'send') {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return res.status(500).json({ error: 'VAPID keys no configuradas. Agregá VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en Vercel.' });
    }
    const subs = await sbReq('rhinos_push_subs?select=sub_data');
    if (!Array.isArray(subs) || !subs.length) {
      return res.json({ ok: true, sent: 0, message: 'Sin suscriptores aún' });
    }
    const payload = JSON.stringify({ title: title || '🦏 RhinosCRM', body: body || '', url: url || '/', tag });
    let sent = 0, errors = 0, expired = [];
    for (const row of subs) {
      try {
        await webpush.sendNotification(row.sub_data, payload, { TTL: 86400 });
        sent++;
      } catch(e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          // Suscripción expirada — eliminar
          expired.push(row.sub_data.endpoint);
        }
        errors++;
      }
    }
    // Limpiar suscripciones expiradas
    for (const ep of expired) {
      await sbReq(`rhinos_push_subs?endpoint=eq.${encodeURIComponent(ep)}`, 'DELETE').catch(() => {});
    }
    return res.json({ ok: true, sent, errors, total: subs.length });
  }

  return res.status(400).json({ error: 'Acción no reconocida' });
};
