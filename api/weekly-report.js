const https = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

const WA_RECIPIENTS = [
  { name: 'Rami', phone: '33617877791', apikey: '9953390' },
  { name: 'Manu', phone: '5491126856731', apikey: '6022688' },
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

function fmtARS(n) {
  const abs = Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (n < 0 ? '−' : '') + '$ ' + abs + ' ARS';
}

function fmtUSD(n) {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '−' : '') + 'USD ' + abs;
}

// Devuelve siempre el monto en ARS, compatible con el nuevo y el viejo sistema
function txToARS(t, tcActual) {
  const amt = Math.abs(+t.amount || 0);
  if (t.currency === 'ARS') return amt;
  if (t.tc_dia && +t.tc_dia > 1) return Math.abs(+t.amount_original || amt) * +t.tc_dia;
  if (t.currency === 'USD') return amt * (tcActual || 1);
  return amt < 5000 ? amt * (tcActual || 1) : amt;
}

module.exports = async function handler(req, res) {
  // Vercel cron authorization
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const weekAgoStr = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const [txs, tcData, metaMetrics, metaAds] = await Promise.all([
      sbGet('rhinos_transactions?order=date.desc'),
      httpGet('https://api.bluelytics.com.ar/v2/latest').catch(() => null),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${weekAgoStr}&select=entity_id,spend,impressions,clicks,leads`).catch(() => []),
      sbGet('meta_ads?select=id,name&limit=200').catch(() => []),
    ]);

    const tcOficial = tcData?.oficial?.value_sell || 0;

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const weekTxs = txs.filter(t => new Date(t.date) >= weekAgo && t.type !== 'pendiente');
    const monthTxs = txs.filter(t => new Date(t.date) >= monthStart && t.type !== 'pendiente');

    const sumARS = (arr, type) => arr.filter(t => t.type === type).reduce((a, t) => a + txToARS(t, tcOficial), 0);

    const totalIngresos = sumARS(txs, 'ingreso');
    const totalGastos = sumARS(txs, 'gasto');
    const totalInversiones = sumARS(txs, 'inversion');
    const balance = totalIngresos - totalGastos;

    const mesIngresos = sumARS(monthTxs, 'ingreso');
    const mesGastos = sumARS(monthTxs, 'gasto');

    const semanaIngresos = sumARS(weekTxs, 'ingreso');
    const semanaGastos = sumARS(weekTxs, 'gasto');

    const pendientes = txs.filter(t => t.type === 'pendiente');
    const totalPendienteARS = pendientes.reduce((a, t) => a + txToARS(t, tcOficial), 0);

    const mesNombre = now.toLocaleDateString('es-AR', { month: 'long' });
    const fechaHoy = now.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
    const tcLabel = tcOficial > 1 ? ` · TC $${tcOficial.toLocaleString('es-AR')}` : '';

    let msg = `🦏 *RhinosApp — Resumen Semanal*\n`;
    msg += `📅 ${fechaHoy}${tcLabel}\n`;
    msg += `━━━━━━━━━━━━━━━\n\n`;

    msg += `📊 *Esta semana:*\n`;
    if (weekTxs.length === 0) {
      msg += `Sin movimientos\n`;
    } else {
      if (semanaIngresos > 0) msg += `💰 Ingresos: +${fmtARS(semanaIngresos)}\n`;
      if (semanaGastos > 0) msg += `💸 Gastos: −${fmtARS(semanaGastos)}\n`;
    }

    msg += `\n📆 *${mesNombre.charAt(0).toUpperCase() + mesNombre.slice(1)} (mes actual):*\n`;
    if (mesIngresos > 0) msg += `💰 Ingresos: +${fmtARS(mesIngresos)}\n`;
    if (mesGastos > 0) msg += `💸 Gastos: −${fmtARS(mesGastos)}\n`;
    if (mesIngresos === 0 && mesGastos === 0) msg += `Sin movimientos este mes\n`;

    msg += `\n📈 *Acumulado total:*\n`;
    msg += `✅ Ingresos: +${fmtARS(totalIngresos)}\n`;
    msg += `❌ Gastos: −${fmtARS(totalGastos)}\n`;
    msg += `📥 Inversiones: +${fmtARS(totalInversiones)}\n`;
    msg += `⚖️ Balance: ${balance >= 0 ? '+' : ''}${fmtARS(balance)}\n`;
    if (tcOficial > 1) {
      msg += `💱 Equivalente: ${balance >= 0 ? '+' : ''}${fmtUSD(balance / tcOficial)}\n`;
    }

    if (pendientes.length > 0) {
      msg += `\n⏳ *Pendientes de pago:*\n`;
      pendientes.slice(0, 3).forEach(p => {
        msg += `• ${p.description}: −${fmtARS(txToARS(p, tcOficial))}\n`;
      });
      if (pendientes.length > 3) msg += `• ...y ${pendientes.length - 3} más\n`;
      msg += `Total comprometido: ${fmtARS(totalPendienteARS)}\n`;
    }

    // ── Meta Ads digest
    if (Array.isArray(metaMetrics) && metaMetrics.length > 0) {
      const adNameMap = {};
      for (const a of (metaAds || [])) adNameMap[a.id] = a.name;

      const adAgg = {};
      for (const m of metaMetrics) {
        if (!adAgg[m.entity_id]) adAgg[m.entity_id] = { spend: 0, impressions: 0, clicks: 0, leads: 0 };
        adAgg[m.entity_id].spend       += parseFloat(m.spend || 0);
        adAgg[m.entity_id].impressions += parseInt(m.impressions || 0);
        adAgg[m.entity_id].clicks      += parseInt(m.clicks || 0);
        adAgg[m.entity_id].leads       += parseInt(m.leads || 0);
      }

      const totSpend = Object.values(adAgg).reduce((s, a) => s + a.spend, 0);
      const totLeads = Object.values(adAgg).reduce((s, a) => s + a.leads, 0);
      const totImpr  = Object.values(adAgg).reduce((s, a) => s + a.impressions, 0);

      // Mejor ad (más leads, menor CPL)
      const adsWithLeads = Object.entries(adAgg).filter(([,a]) => a.leads > 0).sort((a, b) => (a[1].spend / a[1].leads) - (b[1].spend / b[1].leads));
      const worstAd      = Object.entries(adAgg).filter(([,a]) => a.spend > 5 && a.leads === 0).sort((a, b) => b[1].spend - a[1].spend)[0];

      msg += `\n\n📱 *Meta Ads — semana:*\n`;
      msg += `💰 Gasto: ${fmtARS(totSpend)}\n`;
      msg += `👁 Impresiones: ${totImpr.toLocaleString('es-AR')}\n`;
      if (totLeads > 0) {
        msg += `🎯 Leads: ${totLeads} · CPL: ${fmtARS(totSpend / totLeads)}\n`;
      } else {
        msg += `🎯 Leads: 0\n`;
      }
      if (adsWithLeads.length > 0) {
        const [bestId, bestM] = adsWithLeads[0];
        msg += `🏆 Mejor: ${(adNameMap[bestId] || bestId).slice(0, 25)} (${bestM.leads} leads · CPL ${fmtARS(bestM.spend / bestM.leads)})\n`;
      }
      if (worstAd) {
        const [wId, wM] = worstAd;
        msg += `⚠️ Sin leads: ${(adNameMap[wId] || wId).slice(0, 25)} (${fmtARS(wM.spend)} gastado)\n`;
      }
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
