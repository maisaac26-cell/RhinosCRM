const https = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

async function mpGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mercadopago.com', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' }
    }, res => { let r = ''; res.on('data', c => r += c); res.on('end', () => { try { resolve(JSON.parse(r)); } catch(e) { resolve(r); } }); });
    req.on('error', reject); req.end();
  });
}

async function sbPatch(path, data) {
  const body = JSON.stringify(data);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: new URL(SB_URL).hostname, path: '/rest/v1/' + path, method: 'PATCH',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(body) }
    }, res => { res.on('data', ()=>{}); res.on('end', resolve); });
    req.on('error', resolve); req.write(body); req.end();
  });
}

async function sbPost(path, data) {
  const body = JSON.stringify(data);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: new URL(SB_URL).hostname, path: '/rest/v1/' + path, method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
        'Content-Length': Buffer.byteLength(body) }
    }, res => { let r=''; res.on('data',c=>r+=c); res.on('end',()=>{ try{resolve(JSON.parse(r));}catch(e){resolve(null);} }); });
    req.on('error', resolve); req.write(body); req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('MP webhook OK');
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { type, data } = req.body;
    if (type !== 'payment' || !data?.id) return res.status(200).end();

    const payment = await mpGet(`/v1/payments/${data.id}`);
    if (!payment || payment.status !== 'approved') return res.status(200).end();

    const cobroId = payment.external_reference;
    if (!cobroId) return res.status(200).end();

    // Marcar cobro como pagado
    await sbPatch(`rhinos_cobros?id=eq.${encodeURIComponent(cobroId)}`, {
      status: 'pagado',
      fechaPago: new Date().toISOString().slice(0, 10),
      mp_payment_id: String(data.id)
    });

    // Buscar cobro para registrar en Finanzas
    const cobros = await new Promise((resolve) => {
      const req2 = https.request({
        hostname: new URL(SB_URL).hostname,
        path: `/rest/v1/rhinos_cobros?id=eq.${encodeURIComponent(cobroId)}&select=*`,
        method: 'GET',
        headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
      }, res2 => { let r=''; res2.on('data',c=>r+=c); res2.on('end',()=>{ try{resolve(JSON.parse(r));}catch(e){resolve([]); } }); });
      req2.on('error', () => resolve([])); req2.end();
    });

    if (cobros[0]) {
      const c = cobros[0];
      const today = new Date().toISOString().slice(0, 10);
      await sbPost('rhinos_transactions', {
        type: 'ingreso', amount: +payment.transaction_amount || +c.monto || 0,
        date: today,
        description: `Pago MP — ${c.clientId} (${c.periodo})`,
        category: 'Ventas', partner: 'empresa',
        notes: `MercadoPago payment_id: ${data.id}`, currency: 'ARS'
      });
    }

    return res.status(200).json({ received: true });
  } catch(e) {
    console.error('MP webhook error:', e.message);
    return res.status(200).json({ error: e.message });
  }
};
