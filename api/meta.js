// meta.js — Meta Marketing API: sync + agent IA (combinado para Vercel Hobby 12-fn limit)
// ?action=sync  → sincroniza campañas/adsets/ads/métricas (cron 10am UTC)
// ?action=agent → aplica reglas Goodly auto-pausa/escala (cron 11am UTC)
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

async function metaGet(token, path) {
  const r = await fetch(`https://graph.facebook.com/${META_V}/${path}&access_token=${token}`);
  const j = await r.json();
  if (j.error) throw new Error(`Meta API: ${j.error.message}`);
  return j;
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

async function getMetaConfig() {
  const rows = await sbGet('rhinos_config?key=in.(meta_access_token,meta_ad_account_id)&select=key,value');
  const cfg = {};
  for (const { key, value } of rows) cfg[key] = (typeof value === 'string' ? value : JSON.stringify(value)).replace(/^"|"$/g, '').trim();
  return cfg;
}

// ── SYNC ──────────────────────────────────────────────────────────────────────
async function runSync(res) {
  const start = Date.now();
  const log = [];
  try {
    const cfg = await getMetaConfig();
    const token     = cfg.meta_access_token  || '';
    const accountId = cfg.meta_ad_account_id || '';

    if (!token || token === 'pending' || !accountId || accountId === 'pending') {
      return res.status(200).json({ ok: false, msg: 'Meta token/account not configured', _v: 'sync-v1' });
    }

    // 1. Campaigns
    const campsData = await metaGet(token, `act_${accountId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,spend_cap,start_time,stop_time&limit=100`);
    const campaigns = campsData.data || [];
    if (campaigns.length) {
      await sbReq('POST', 'meta_campaigns?on_conflict=id', campaigns.map(c => ({
        id: c.id, name: c.name, status: c.status, objective: c.objective || null,
        budget_daily: c.daily_budget    ? parseFloat(c.daily_budget) / 100    : null,
        budget_total: c.lifetime_budget ? parseFloat(c.lifetime_budget) / 100 : null,
        spend_cap:    c.spend_cap       ? parseFloat(c.spend_cap) / 100       : null,
        start_time: c.start_time || null, stop_time: c.stop_time || null,
        updated_at: new Date().toISOString(),
      })));
    }
    log.push(`campaigns: ${campaigns.length}`);

    // 2. AdSets
    const adsetsData = await metaGet(token, `act_${accountId}/adsets?fields=id,name,status,campaign_id,daily_budget,lifetime_budget,targeting,billing_event,optimization_goal&limit=200`);
    const adsets = adsetsData.data || [];
    if (adsets.length) {
      await sbReq('POST', 'meta_adsets?on_conflict=id', adsets.map(a => ({
        id: a.id, campaign_id: a.campaign_id, name: a.name, status: a.status,
        budget_daily:      a.daily_budget    ? parseFloat(a.daily_budget) / 100    : null,
        budget_total:      a.lifetime_budget ? parseFloat(a.lifetime_budget) / 100 : null,
        targeting_spec:    a.targeting || null, billing_event: a.billing_event || null,
        optimization_goal: a.optimization_goal || null, updated_at: new Date().toISOString(),
      })));
    }
    log.push(`adsets: ${adsets.length}`);

    // 3. Ads
    const adsData = await metaGet(token, `act_${accountId}/ads?fields=id,name,status,adset_id,campaign_id,creative{id,thumbnail_url}&limit=500`);
    const ads = adsData.data || [];
    if (ads.length) {
      await sbReq('POST', 'meta_ads?on_conflict=id', ads.map(a => ({
        id: a.id, adset_id: a.adset_id, campaign_id: a.campaign_id, name: a.name, status: a.status,
        creative_id: a.creative?.id || null, thumbnail_url: a.creative?.thumbnail_url || null,
        updated_at: new Date().toISOString(),
      })));
    }
    log.push(`ads: ${ads.length}`);

    // 4. Metrics last 7 days
    const today = new Date();
    const since = new Date(today); since.setDate(since.getDate() - 7);
    const timeRange = encodeURIComponent(JSON.stringify({ since: isoDate(since), until: isoDate(today) }));
    const fields = 'campaign_id,adset_id,ad_id,impressions,clicks,spend,reach,ctr,cpc,cpm,actions,cost_per_action_type,purchase_roas';
    const metricsData = await metaGet(token, `act_${accountId}/insights?level=ad&fields=${fields}&time_range=${timeRange}&time_increment=1&limit=1000`);
    const metrics = metricsData.data || [];
    if (metrics.length) {
      const rows = metrics.map(m => {
        const conversions = (m.actions || []).find(a => a.action_type === 'purchase')?.value || 0;
        const cpa  = (m.cost_per_action_type || []).find(a => a.action_type === 'purchase')?.value || 0;
        const roas = (m.purchase_roas || []).find(a => a.action_type === 'omni_purchase')?.value || 0;
        return {
          entity_type: 'ad', entity_id: m.ad_id, date_start: m.date_start,
          impressions: parseInt(m.impressions || 0), clicks: parseInt(m.clicks || 0),
          spend: parseFloat(m.spend || 0), reach: parseInt(m.reach || 0),
          ctr: parseFloat(m.ctr || 0), cpc: parseFloat(m.cpc || 0), cpm: parseFloat(m.cpm || 0),
          conversions: parseInt(conversions), cost_per_result: parseFloat(cpa), roas: parseFloat(roas),
          raw_data: m, synced_at: new Date().toISOString(),
        };
      });
      await sbReq('POST', 'meta_ad_metrics?on_conflict=entity_type,entity_id,date_start', rows);
    }
    log.push(`metrics rows: ${metrics.length}`);

    return res.status(200).json({ ok: true, log, ms: Date.now() - start, _v: 'sync-v1' });
  } catch (err) {
    console.error('[meta-sync]', err.message);
    return res.status(200).json({ ok: false, error: err.message, log, ms: Date.now() - start, _v: 'sync-v1' });
  }
}

// ── AGENT ─────────────────────────────────────────────────────────────────────
async function runAgent(res) {
  const actions = [];
  const skipped = [];
  try {
    const cfg = await getMetaConfig();
    const token     = cfg.meta_access_token  || '';
    const accountId = cfg.meta_ad_account_id || '';

    if (!token || token === 'pending' || !accountId || accountId === 'pending') {
      return res.status(200).json({ ok: false, msg: 'Meta not configured', _v: 'agent-v1' });
    }

    const ads = await sbGet('meta_ads?status=eq.ACTIVE&select=id,name,adset_id,campaign_id,created_at');
    const today = new Date();
    const since7 = new Date(today); since7.setDate(since7.getDate() - 7);
    const since7str = isoDate(since7);

    for (const ad of ads) {
      const ageDays = (today - new Date(ad.created_at)) / 86400000;
      if (ageDays < 7) { skipped.push({ id: ad.id, reason: 'learning_period' }); continue; }

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
        const adsetRows = await sbGet(`meta_adsets?id=eq.${ad.adset_id}&select=id,budget_daily,budget_total,updated_at`);
        if (!adsetRows.length) { skipped.push({ id: ad.id, reason: 'adset_missing' }); continue; }
        const adset = adsetRows[0];
        const daysSinceScale = (today - new Date(adset.updated_at)) / 86400000;
        if (daysSinceScale < 4) { skipped.push({ id: ad.id, reason: 'scale_too_soon', days: daysSinceScale.toFixed(1) }); continue; }

        const newBudget = adset.budget_daily ? Math.round(parseFloat(adset.budget_daily) * 1.25 * 100) : null;
        if (newBudget) {
          try {
            await metaPatch(token, adset.id, { daily_budget: newBudget });
            await sbReq('PATCH', `meta_adsets?id=eq.${adset.id}`, { budget_daily: newBudget / 100, updated_at: new Date().toISOString() });
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

export default async function handler(req, res) {
  const action = req.query?.action || 'sync';
  if (action === 'agent') return runAgent(res);
  return runSync(res);
}
