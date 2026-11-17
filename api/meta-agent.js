// meta-agent.js — Agente IA: auto-pausa perdedores + escala ganadores (metodología Goodly)
// Reglas:
//   Ganador:   CTR >= 1.5% AND ROAS >= 2 (o conversiones >= 3 en 7d) → escalar +25% cada 4d
//   Perdedor:  spend >= $5 AND clicks = 0, o CTR < 0.3% con spend >= $10 → pausar
//   Período de aprendizaje: no tocar ads con < 7 días de vida o < $3 de gasto
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const META_V = 'v21.0';

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`SB GET ${path}: ${r.status}`);
  return r.json();
}

async function sbReq(method, path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`SB ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json().catch(() => null);
}

async function metaPatch(token, entityId, body) {
  const r = await fetch(`https://graph.facebook.com/${META_V}/${entityId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`Meta PATCH ${entityId}: ${j.error.message}`);
  return j;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

export default async function handler(req, res) {
  const actions = [];
  const skipped = [];

  try {
    const cfgRows = await sbGet('rhinos_config?key=in.(meta_access_token,meta_ad_account_id)&select=key,value');
    const cfg = {};
    for (const { key, value } of cfgRows) cfg[key] = (typeof value === 'string' ? value : String(value)).replace(/^"|"$/g, '').trim();

    const token     = cfg.meta_access_token  || '';
    const accountId = cfg.meta_ad_account_id || '';

    if (!token || token === 'pending' || !accountId || accountId === 'pending') {
      return res.status(200).json({ ok: false, msg: 'Meta not configured', _v: 'agent-v1' });
    }

    // Active ads from DB
    const ads = await sbGet('meta_ads?status=eq.ACTIVE&select=id,name,adset_id,campaign_id,created_at');

    const today = new Date();
    const since7 = new Date(today); since7.setDate(since7.getDate() - 7);
    const since7str = isoDate(since7);

    for (const ad of ads) {
      const ageMs = today - new Date(ad.created_at);
      const ageDays = ageMs / 86400000;

      // 7-day learning window
      if (ageDays < 7) { skipped.push({ id: ad.id, reason: 'learning_period' }); continue; }

      // Aggregate metrics last 7 days
      const rows = await sbGet(`meta_ad_metrics?entity_type=eq.ad&entity_id=eq.${ad.id}&date_start=gte.${since7str}&select=spend,clicks,impressions,conversions,roas,ctr`);

      if (!rows.length) { skipped.push({ id: ad.id, reason: 'no_data' }); continue; }

      const totSpend       = rows.reduce((s, r) => s + parseFloat(r.spend || 0), 0);
      const totClicks      = rows.reduce((s, r) => s + parseInt(r.clicks || 0), 0);
      const totImpressions = rows.reduce((s, r) => s + parseInt(r.impressions || 0), 0);
      const totConversions = rows.reduce((s, r) => s + parseInt(r.conversions || 0), 0);
      const avgCtr  = totImpressions > 0 ? (totClicks / totImpressions) * 100 : 0;
      const avgRoas = rows.reduce((s, r) => s + parseFloat(r.roas || 0), 0) / rows.length;

      const isLoser  = (totSpend >= 5 && totClicks === 0) || (avgCtr < 0.3 && totSpend >= 10);
      const isWinner = avgCtr >= 1.5 && (avgRoas >= 2 || totConversions >= 3);

      if (isLoser) {
        try {
          await metaPatch(token, ad.id, { status: 'PAUSED' });
          await sbReq('PATCH', `meta_ads?id=eq.${ad.id}`, { status: 'PAUSED', updated_at: new Date().toISOString() });
          actions.push({ id: ad.id, name: ad.name, action: 'paused', spend: totSpend, ctr: avgCtr.toFixed(2) });
        } catch (e) { skipped.push({ id: ad.id, reason: e.message }); }

      } else if (isWinner) {
        // Get current adset budget
        const adsetRows = await sbGet(`meta_adsets?id=eq.${ad.adset_id}&select=id,budget_daily,budget_total,updated_at`);
        if (!adsetRows.length) { skipped.push({ id: ad.id, reason: 'adset_missing' }); continue; }

        const adset = adsetRows[0];
        const lastScale = new Date(adset.updated_at);
        const daysSinceScale = (today - lastScale) / 86400000;

        // Only scale every 4 days minimum
        if (daysSinceScale < 4) { skipped.push({ id: ad.id, reason: 'scale_too_soon', days: daysSinceScale.toFixed(1) }); continue; }

        const scaleFactor = 1.25;
        const newBudget = adset.budget_daily ? Math.round(parseFloat(adset.budget_daily) * scaleFactor * 100) : null;

        if (newBudget) {
          try {
            await metaPatch(token, adset.id, { daily_budget: newBudget });
            await sbReq('PATCH', `meta_adsets?id=eq.${adset.id}`, {
              budget_daily: newBudget / 100,
              updated_at: new Date().toISOString(),
            });
            actions.push({ id: ad.id, name: ad.name, action: 'scaled_+25%', new_budget_ars: newBudget / 100, ctr: avgCtr.toFixed(2), roas: avgRoas.toFixed(2) });
          } catch (e) { skipped.push({ id: ad.id, reason: e.message }); }
        }
      }
    }

    return res.status(200).json({ ok: true, actions, skipped, _v: 'agent-v1' });

  } catch (err) {
    console.error('[meta-agent]', err.message);
    return res.status(200).json({ ok: false, error: err.message, actions, skipped, _v: 'agent-v1' });
  }
}
