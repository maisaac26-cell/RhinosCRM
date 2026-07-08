// Cron de emails automáticos — se ejecuta diariamente vía Vercel Cron.
// Lee rhinos_auto_emails desde Supabase, detecta cuáles hay que enviar hoy,
// los manda via Gmail API con el token guardado en rhinos_config.

const https = require('https');

const SB_URL  = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

function sbReq(method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: new URL(SB_URL).hostname,
      path: '/rest/v1/' + path, method,
      headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
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

async function getGmailToken() {
  const cfg = await sbReq('GET', 'rhinos_config?key=in.(gmail_refresh_token,gmail_access_token,gmail_token_expiry)');
  const map = {};
  (Array.isArray(cfg) ? cfg : []).forEach(r => { map[r.key] = r.value; });
  if (!map.gmail_refresh_token) throw new Error('gmail_refresh_token no configurado en rhinos_config');

  const expired = map.gmail_token_expiry && new Date(map.gmail_token_expiry) < new Date(Date.now() + 60000);
  if (!expired && map.gmail_access_token) return map.gmail_access_token;

  // Refrescar
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
  https.request({ hostname: new URL(SB_URL).hostname, path: '/rest/v1/rhinos_config', method: 'POST',
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(upd), 'Prefer': 'resolution=merge-duplicates,return=minimal' }
  }, () => {}).end(upd);
  return refreshed.access_token;
}

async function sendGmail(accessToken, to, subject, bodyText) {
  const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject || '').toString('base64') + '?=';
  const raw = `MIME-Version: 1.0\r\nFrom: comercial@rhinosapp.com\r\nTo: ${to}\r\nSubject: ${encodedSubject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText}`;
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const payload = JSON.stringify({ raw: encoded });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let raw2 = ''; res.on('data', c => raw2 += c);
      res.on('end', () => { try { resolve(JSON.parse(raw2)); } catch { resolve({}); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

function isDue(em, today, todayDow, todayDom) {
  if (em.expires_at && today > em.expires_at) return false;
  if (em.last_sent_at && em.last_sent_at.slice(0, 10) === today) return false;
  switch (em.frequency) {
    case 'once':    return em.schedule_day === today;
    case 'daily':   return true;
    case 'weekly':  return String(todayDow) === String(em.schedule_day);
    case 'monthly': return String(todayDom) === String(em.schedule_day);
    default: return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const today    = new Date().toISOString().slice(0, 10);
  const todayDow = new Date().getDay();   // 0=Dom, 1=Lun, ..., 6=Sáb
  const todayDom = new Date().getDate();  // 1-31

  const summary = { sent: [], skipped: [], errors: [], digest: null };

  try {
    let accessToken;
    try { accessToken = await getGmailToken(); }
    catch(e) { return res.status(200).json({ ok: false, error: 'Token Gmail: ' + e.message, summary }); }

    // ── Digest diario — lun-vie, ventana 8-10hs AR ────────────────────────
    try {
      const horaAR = ((new Date().getUTCHours() - 3) + 24) % 24;
      if ([1,2,3,4,5].includes(todayDow) && horaAR >= 8 && horaAR <= 10) {
        const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const [prospNuevos, todosProsp, leadsNuevos, todosLeads, clientes, abiertosAyer, repliesAyer, wasAyer] =
          await Promise.all([
            sbReq('GET', `rhinos_prospectos?select=id&created_at=gte.${ayer}T03:00:00Z&created_at=lt.${today}T03:00:00Z`),
            sbReq('GET', 'rhinos_prospectos?select=estado'),
            sbReq('GET', `rhinos_leads?select=id&created_at=gte.${ayer}T03:00:00Z`),
            sbReq('GET', 'rhinos_leads?select=status'),
            sbReq('GET', 'rhinos_clientes?select=id&activo=eq.true'),
            sbReq('GET', `rhinos_prospectos?select=id&ia_abierto=eq.true&ia_ultima_apertura=gte.${ayer}T03:00:00Z`),
            sbReq('GET', `rhinos_prospectos?select=id&ia_reply=eq.true&ia_reply_fecha=gte.${ayer}T03:00:00Z`),
            sbReq('GET', `rhinos_prospectos?select=id&ia_wa_enviado=eq.true&ia_wa_fecha=gte.${ayer}T03:00:00Z`),
          ]).catch(() => [[],[],[],[],[],[],[],[]]);

        const arr = a => Array.isArray(a) ? a : [];
        const en_cola  = arr(todosProsp).filter(r => r.estado === 'nuevo').length;
        const frios    = arr(todosProsp).filter(r => r.estado === 'frio').length;
        const pipeline = arr(todosLeads).filter(r => !['perdido','imposible'].includes(r.status)).length;
        const demos    = arr(todosLeads).filter(r => ['demo_agendada','demo'].includes(r.status)).length;

        const cfgD   = await sbReq('GET', 'rhinos_config?key=in.(vendedor_nombre_vendedor,vendedor_razon_social,gmail_email)');
        const cfgDm  = {}; arr(cfgD).forEach(r => { cfgDm[r.key] = r.value; });
        const nombre = cfgDm.vendedor_nombre_vendedor || 'Equipo';
        const razon  = cfgDm.vendedor_razon_social    || 'RhinosCRM';
        const destino = cfgDm.gmail_email             || 'comercial@rhinosapp.com';

        const cuerpo = [
          `Buenos días, ${nombre}! Acá el resumen de ayer (${ayer}):`,
          '',
          `📥  Prospectos nuevos ayer:   ${arr(prospNuevos).length}`,
          `👁️  Emails abiertos ayer:     ${arr(abiertosAyer).length}`,
          `💬  Replies recibidos ayer:   ${arr(repliesAyer).length}`,
          `📲  WA enviados ayer:         ${arr(wasAyer).length}`,
          `🆕  Leads nuevos ayer:        ${arr(leadsNuevos).length}`,
          '',
          `Estado general:`,
          `  • En cola (sin contactar): ${en_cola}`,
          `  • Prospectos fríos:        ${frios}`,
          `  • Pipeline activo (leads): ${pipeline}`,
          `  • Demos agendadas:         ${demos}`,
          `  • Clientes activos:        ${arr(clientes).length}`,
          '',
          `-- ${razon} · Digest automático`,
        ].join('\n');

        await sendGmail(accessToken, destino, `📊 Digest ${razon} — ${ayer}`, cuerpo);
        summary.digest = { ok: true, fecha: ayer, destino };
      }
    } catch(e) {
      summary.errors.push({ tipo: 'digest', error: e.message });
    }

    const emails = await sbReq('GET', 'rhinos_auto_emails?active=eq.true&order=created_at.asc');
    if (!Array.isArray(emails) || !emails.length) return res.status(200).json({ ok: true, summary });

    for (const em of emails) {
      if (!isDue(em, today, todayDow, todayDom)) { summary.skipped.push(em.id); continue; }
      try {
        await sendGmail(accessToken, em.to_email, em.subject, em.body);
        await sbReq('PATCH', `rhinos_auto_emails?id=eq.${em.id}`, { last_sent_at: new Date().toISOString() });
        summary.sent.push({ id: em.id, name: em.name, to: em.to_email });
      } catch(e) {
        summary.errors.push({ id: em.id, name: em.name, error: e.message });
      }
    }
    // Keepalive: ping Supabase + guardar TC del día (antes en keepalive.js)
    try {
      const tcData = await new Promise((resolve) => {
        https.get('https://api.bluelytics.com.ar/v2/latest', (r) => {
          let raw = ''; r.on('data', c => raw += c);
          r.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        }).on('error', () => resolve({}));
      });
      if (tcData.oficial) {
        const today2 = new Date().toISOString().slice(0, 10);
        const tc = JSON.stringify({ fecha: today2, oficial_compra: tcData.oficial.value_buy, oficial_venta: tcData.oficial.value_sell, blue_compra: tcData.blue?.value_buy, blue_venta: tcData.blue?.value_sell, fuente: 'Banco Nación Argentina' });
        const r2 = https.request({ hostname: new URL(SB_URL).hostname, path: '/rest/v1/rhinos_tc_historico', method: 'POST', headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tc), 'Prefer': 'resolution=merge-duplicates,return=minimal' } }, () => {});
        r2.on('error', () => {}); r2.write(tc); r2.end();
      }
    } catch {}

    return res.status(200).json({ ok: true, summary });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
