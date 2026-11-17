// meta-sync.js — sync Meta Marketing API → Supabase
// Cron: daily. Fetches campaigns, adsets, ads + last 7 days of metrics.
const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const META_V  = 'v21.0';

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

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`SB GET ${path}: ${r.status}`);
  return r.json();
}

async function getConfig() {
  const rows = await sbGet('rhinos_config?key=in.(meta_access_token,meta_ad_account_id)&select=key,value');
  const cfg = {};
  for (const { key, value } of rows) cfg[key] = typeof value === 'string' ? value : JSON.stringify(value).replace(/^"|"$/g, '');
  return cfg;
}

async function metaGet(token, path) {
  const r = await fetch(`https://graph.facebook.com/${META_V}/${path}&access_token=${token}`);
  const j = await r.json();
  if (j.error) throw new Error(`Meta API: ${j.error.message}`);
  return j;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

export default async function handler(req, res) {
  const start = Date.now();
  const log = [];

  try {
    const cfg = await getConfig();
    const token     = (cfg.meta_access_token   || '').replace(/^"|"$/g, '').trim();
    const accountId = (cfg.meta_ad_account_id  || '').replace(/^"|"$/g, '').trim();

    if (!token || token === 'pending' || !accountId || accountId === 'pending') {
      return res.status(200).json({ ok: false, msg: 'Meta token/account not configured', _v: 'sync-v1' });
    }

    // ── 1. Campaigns ──────────────────────────────────────────────
    const campsData = await metaGet(token,
      `act_${accountId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,spend_cap,start_time,stop_time&limit=100`
    );
    const campaigns = campsData.data || [];

    if (campaigns.length) {
      await sbReq('POST', 'meta_campaigns?on_conflict=id', campaigns.map(c => ({
        id:           c.id,
        name:         c.name,
        status:       c.status,
        objective:    c.objective || null,
        budget_daily: c.daily_budget    ? parseFloat(c.daily_budget) / 100    : null,
        budget_total: c.lifetime_budget ? parseFloat(c.lifetime_budget) / 100 : null,
        spend_cap:    c.spend_cap       ? parseFloat(c.spend_cap) / 100       : null,
        start_time:   c.start_time || null,
        stop_time:    c.stop_time  || null,
        updated_at:   new Date().toISOString(),
      })));
    }
    log.push(`campaigns: ${campaigns.length}`);

    // ── 2. AdSets ─────────────────────────────────────────────────
    const adsetsData = await metaGet(token,
      `act_${accountId}/adsets?fields=id,name,status,campaign_id,daily_budget,lifetime_budget,targeting,billing_event,optimization_goal&limit=200`
    );
    const adsets = adsetsData.data || [];

    if (adsets.length) {
      await sbReq('POST', 'meta_adsets?on_conflict=id', adsets.map(a => ({
        id:                a.id,
        campaign_id:       a.campaign_id,
        name:              a.name,
        status:            a.status,
        budget_daily:      a.daily_budget    ? parseFloat(a.daily_budget) / 100    : null,
        budget_total:      a.lifetime_budget ? parseFloat(a.lifetime_budget) / 100 : null,
        targeting_spec:    a.targeting || null,
        billing_event:     a.billing_event || null,
        optimization_goal: a.optimization_goal || null,
        updated_at:        new Date().toISOString(),
      })));
    }
    log.push(`adsets: ${adsets.length}`);

    // ── 3. Ads ────────────────────────────────────────────────────
    const adsData = await metaGet(token,
      `act_${accountId}/ads?fields=id,name,status,adset_id,campaign_id,creative{id,thumbnail_url}&limit=500`
    );
    const ads = adsData.data || [];

    if (ads.length) {
      await sbReq('POST', 'meta_ads?on_conflict=id', ads.map(a => ({
        id:            a.id,
        adset_id:      a.adset_id,
        campaign_id:   a.campaign_id,
        name:          a.name,
        status:        a.status,
        creative_id:   a.creative?.id || null,
        thumbnail_url: a.creative?.thumbnail_url || null,
        updated_at:    new Date().toISOString(),
      })));
    }
    log.push(`ads: ${ads.length}`);

    // ── 4. Metrics last 7 days ────────────────────────────────────
    const today  = new Date();
    const since  = new Date(today); since.setDate(since.getDate() - 7);
    const timeRange = encodeURIComponent(JSON.stringify({ since: isoDate(since), until: isoDate(today) }));

    const fields = 'campaign_id,adset_id,ad_id,impressions,clicks,spend,reach,ctr,cpc,cpm,actions,cost_per_action_type,purchase_roas';

    const metricsData = await metaGet(token,
      `act_${accountId}/insights?level=ad&fields=${fields}&time_range=${timeRange}&time_increment=1&limit=1000`
    );
    const metrics = metricsData.data || [];

    if (metrics.length) {
      const rows = metrics.map(m => {
        const conversions = (m.actions || []).find(a => a.action_type === 'purchase')?.value || 0;
        const cpa = (m.cost_per_action_type || []).find(a => a.action_type === 'purchase')?.value || 0;
        const roas = (m.purchase_roas || []).find(a => a.action_type === 'omni_purchase')?.value || 0;
        return {
          entity_type:     'ad',
          entity_id:       m.ad_id,
          date_start:      m.date_start,
          impressions:     parseInt(m.impressions || 0),
          clicks:          parseInt(m.clicks || 0),
          spend:           parseFloat(m.spend || 0),
          reach:           parseInt(m.reach || 0),
          ctr:             parseFloat(m.ctr || 0),
          cpc:             parseFloat(m.cpc || 0),
          cpm:             parseFloat(m.cpm || 0),
          conversions:     parseInt(conversions),
          cost_per_result: parseFloat(cpa),
          roas:            parseFloat(roas),
          raw_data:        m,
          synced_at:       new Date().toISOString(),
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
