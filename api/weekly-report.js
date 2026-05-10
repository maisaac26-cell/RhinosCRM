const https = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

const WA_RECIPIENTS = [
  { name: 'Rami', phone: '33617877791', apikey: '9953390' },
  // { name: 'Manu', phone: 'NUMERO', apikey: 'APIKEY' },
  // { name: 'Guille', phone: 'NUMERO', apikey: 'APIKEY' },
  // { name: 'Poli', phone: 'NUMERO', apikey: 'APIKEY' },
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(raw));
    }).on('error', reject);
  });
}

function sbGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SB_URL}/rest/v1/${endpoint}`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw.slice(0,200))); } });
    });
    req.on('error', reject); req.end();
  });
}

async function sendWhatsApp(phone, apikey, text) {
  const encoded = encodeURIComponent(text);
  await httpGet(`https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encoded}&apikey=${apikey}`);
}

function fmtUSD(n) {
  return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = async function handler(req, res) {
  // Vercel cron authorization
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const txs = await sbGet('rhinos_transactions?order=date.desc');

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const weekTxs = txs.filter(t => new Date(t.date) >= weekAgo && t.type !== 'pendiente');
    const monthTxs = txs.filter(t => new Date(t.date) >= monthStart && t.type !== 'pendiente');

    const sum = (arr, type) => arr.filter(t => t.type === type).reduce((a, t) => a + +t.amount, 0);

    const totalIngresos = sum(txs, 'ingreso');
    const totalGastos = sum(txs, 'gasto');
    const totalInversiones = sum(txs, 'inversion');
    const balance = totalIngresos - totalGastos;

    const mesIngresos = sum(monthTxs, 'ingreso');
    const mesGastos = sum(monthTxs, 'gasto');

    const semanaIngresos = sum(weekTxs, 'ingreso');
    const semanaGastos = sum(weekTxs, 'gasto');

    const pendientes = txs.filter(t => t.type === 'pendiente');
    const totalPendiente = pendientes.reduce((a, t) => a + +t.amount, 0);

    const mesNombre = now.toLocaleDateString('es-AR', { month: 'long' });
    const fechaHoy = now.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

    let msg = `🦏 *RhinosApp — Resumen Semanal*\n`;
    msg += `📅 ${fechaHoy}\n`;
    msg += `━━━━━━━━━━━━━━━\n\n`;

    msg += `📊 *Esta semana:*\n`;
    if (weekTxs.length === 0) {
      msg += `Sin movimientos\n`;
    } else {
      if (semanaIngresos > 0) msg += `💰 Ingresos: +${fmtUSD(semanaIngresos)} USD\n`;
      if (semanaGastos > 0) msg += `💸 Gastos: −${fmtUSD(semanaGastos)} USD\n`;
    }

    msg += `\n📆 *${mesNombre.charAt(0).toUpperCase() + mesNombre.slice(1)} (mes actual):*\n`;
    if (mesIngresos > 0) msg += `💰 Ingresos: +${fmtUSD(mesIngresos)} USD\n`;
    if (mesGastos > 0) msg += `💸 Gastos: −${fmtUSD(mesGastos)} USD\n`;
    if (mesIngresos === 0 && mesGastos === 0) msg += `Sin movimientos este mes\n`;

    msg += `\n📈 *Acumulado total:*\n`;
    msg += `✅ Ingresos: +${fmtUSD(totalIngresos)} USD\n`;
    msg += `❌ Gastos: −${fmtUSD(totalGastos)} USD\n`;
    msg += `📥 Inversiones: +${fmtUSD(totalInversiones)} USD\n`;
    msg += `⚖️ Balance: ${balance >= 0 ? '+' : ''}${fmtUSD(balance)} USD\n`;

    if (pendientes.length > 0) {
      msg += `\n⏳ *Pendientes de pago:*\n`;
      pendientes.slice(0, 3).forEach(p => {
        msg += `• ${p.description}: −${fmtUSD(+p.amount)} USD\n`;
      });
      if (pendientes.length > 3) msg += `• ...y ${pendientes.length - 3} más\n`;
      msg += `Total comprometido: ${fmtUSD(totalPendiente)} USD\n`;
    }

    msg += `\n_RhinosApp 🦏_`;

    for (const r of WA_RECIPIENTS) {
      await sendWhatsApp(r.phone, r.apikey, msg);
    }

    return res.status(200).json({ ok: true, sent: WA_RECIPIENTS.length });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
