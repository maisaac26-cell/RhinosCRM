const https = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

async function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
    }).on('error', reject);
  });
}

async function sbPost(endpoint, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: new URL(SB_URL).hostname,
      path: `/rest/v1/${endpoint}`,
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Prefer': 'resolution=merge-duplicates,return=minimal' }
    }, (r) => { let raw=''; r.on('data',c=>raw+=c); r.on('end',()=>resolve({status:r.statusCode})); });
    req.on('error', reject); req.write(payload); req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = { timestamp: new Date().toISOString() };

  try {
    // 1. Ping Supabase (keep-alive)
    const ping = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: new URL(SB_URL).hostname,
        path: '/rest/v1/rhinos_transactions?limit=1',
        method: 'GET',
        headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
      }, (r) => { let raw=''; r.on('data',c=>raw+=c); r.on('end',()=>resolve({status:r.statusCode})); });
      req2.on('error', reject); req2.end();
    });
    results.supabase = ping.status;

    // 2. Guardar TC del día en tabla histórica
    try {
      const tcData = await httpGet('https://api.bluelytics.com.ar/v2/latest');
      const today = new Date().toISOString().slice(0, 10);
      await sbPost('rhinos_tc_historico', {
        fecha: today,
        oficial_compra: tcData.oficial?.value_buy || null,
        oficial_venta: tcData.oficial?.value_sell || null,
        blue_compra: tcData.blue?.value_buy || null,
        blue_venta: tcData.blue?.value_sell || null,
        fuente: 'Banco Nación Argentina'
      });
      results.tc_guardado = { fecha: today, oficial: tcData.oficial?.value_sell };
    } catch(e) {
      results.tc_error = e.message;
    }

    return res.status(200).json({ ok: true, ...results });
  } catch(e) {
    return res.status(500).json({ error: e.message, ...results });
  }
};
