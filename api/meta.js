// meta.js — Meta Marketing API: sync + agent IA (combinado para Vercel Hobby 12-fn limit)
// ?action=sync  → sincroniza campañas/adsets/ads/métricas (cron 10am UTC)
// ?action=agent → aplica reglas Goodly auto-pausa/escala (cron 11am UTC)
const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';
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

async function metaPost(token, path, body) {
  const r = await fetch(`https://graph.facebook.com/${META_V}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`Meta POST ${path}: ${j.error.message}`);
  return j;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function getMetaConfig() {
  const keys = 'meta_access_token,meta_ad_account_id,meta_page_id,meta_webhook_verify_token,meta_target_cpl,meta_min_ctr,meta_max_freq,meta_max_cpl_mult,meta_min_spend_pause';
  const rows = await sbGet(`rhinos_config?key=in.(${keys})&select=key,value`);
  const cfg = {};
  for (const { key, value } of rows) cfg[key] = (typeof value === 'string' ? value : JSON.stringify(value)).replace(/^"|"$/g, '').trim();
  return cfg;
}

async function pushNotify(title, body) {
  try {
    await fetch('https://rhinos-crm.vercel.app/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send', title, body, tag: 'meta-agent' }),
    });
  } catch(e) {}
}

// ── SYNC ──────────────────────────────────────────────────────────────────────
async function runSync(res) {
  const start = Date.now();
  const log = [];
  try {
    const cfg = await getMetaConfig();
    const token     = cfg.meta_access_token  || '';
    const rawId     = cfg.meta_ad_account_id || '';
    const accountId = rawId.replace(/^act_/i, '');

    if (!token || token === 'pending' || !accountId || rawId === 'pending') {
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
    const fields = 'campaign_id,adset_id,ad_id,impressions,clicks,spend,reach,ctr,cpc,cpm,frequency,actions,cost_per_action_type,purchase_roas';
    const metricsData = await metaGet(token, `act_${accountId}/insights?level=ad&fields=${fields}&time_range=${timeRange}&time_increment=1&limit=1000`);
    const metrics = metricsData.data || [];
    if (metrics.length) {
      const rows = metrics.map(m => {
        const conversions      = parseInt((m.actions || []).find(a => a.action_type === 'purchase')?.value || 0);
        const leads            = parseInt((m.actions || []).find(a => a.action_type === 'lead')?.value || 0);
        const messages_started = parseInt((m.actions || []).find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || 0);
        const cpa          = parseFloat((m.cost_per_action_type || []).find(a => a.action_type === 'purchase')?.value || 0);
        const cost_per_lead = parseFloat((m.cost_per_action_type || []).find(a => a.action_type === 'lead')?.value || 0);
        const roas         = parseFloat((m.purchase_roas || []).find(a => a.action_type === 'omni_purchase')?.value || 0);
        return {
          entity_type: 'ad', entity_id: m.ad_id, date_start: m.date_start,
          impressions: parseInt(m.impressions || 0), clicks: parseInt(m.clicks || 0),
          spend: parseFloat(m.spend || 0), reach: parseInt(m.reach || 0),
          ctr: parseFloat(m.ctr || 0), cpc: parseFloat(m.cpc || 0), cpm: parseFloat(m.cpm || 0),
          frequency: parseFloat(m.frequency || 0),
          conversions, cost_per_result: cpa, roas,
          leads, messages_started, cost_per_lead,
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

// ── AGENT v2 ──────────────────────────────────────────────────────────────────
async function runAgent(res) {
  const actions = [];
  const skipped = [];
  try {
    const cfg       = await getMetaConfig();
    const token     = cfg.meta_access_token  || '';
    const rawId2    = cfg.meta_ad_account_id || '';
    const accountId = rawId2.replace(/^act_/i, '');
    const targetCpl  = parseFloat(cfg.meta_target_cpl   || 0);   // 0 = deshabilitado
    const minCtr     = parseFloat(cfg.meta_min_ctr       || 0.3); // CTR mínimo %
    const maxFreq    = parseFloat(cfg.meta_max_freq      || 3.5); // frecuencia máxima
    const cplMult    = parseFloat(cfg.meta_max_cpl_mult  || 2);   // pausa si CPL > targetCpl × esto
    const minSpend   = parseFloat(cfg.meta_min_spend_pause|| 10); // gasto mínimo antes de pausar

    if (!token || token === 'pending' || !accountId || rawId2 === 'pending') {
      return res.status(200).json({ ok: false, msg: 'Meta not configured', _v: 'agent-v2' });
    }

    const ads = await sbGet('meta_ads?status=eq.ACTIVE&select=id,name,adset_id,campaign_id,created_at');
    const today = new Date();
    const since7 = new Date(today); since7.setDate(since7.getDate() - 7);
    const since7str = isoDate(since7);

    for (const ad of ads) {
      const ageDays = (today - new Date(ad.created_at)) / 86400000;
      if (ageDays < 7) { skipped.push({ id: ad.id, reason: 'learning_period' }); continue; }

      const rows = await sbGet(`meta_ad_metrics?entity_type=eq.ad&entity_id=eq.${ad.id}&date_start=gte.${since7str}&select=spend,clicks,impressions,conversions,roas,ctr,leads,frequency`);
      if (!rows.length) { skipped.push({ id: ad.id, reason: 'no_data' }); continue; }

      const totSpend       = rows.reduce((s, r) => s + parseFloat(r.spend || 0), 0);
      const totClicks      = rows.reduce((s, r) => s + parseInt(r.clicks || 0), 0);
      const totImpressions = rows.reduce((s, r) => s + parseInt(r.impressions || 0), 0);
      const totConversions = rows.reduce((s, r) => s + parseInt(r.conversions || 0), 0);
      const totLeads       = rows.reduce((s, r) => s + parseInt(r.leads || 0), 0);
      const avgCtr         = totImpressions > 0 ? (totClicks / totImpressions) * 100 : 0;
      const avgRoas        = rows.reduce((s, r) => s + parseFloat(r.roas || 0), 0) / rows.length;
      const avgFreq        = rows.reduce((s, r) => s + parseFloat(r.frequency || 0), 0) / rows.length;
      const cpl            = totLeads > 0 ? totSpend / totLeads : 0;

      // Determine pause reason (priority order, using configurable thresholds)
      let pauseReason = null;
      if (avgFreq > maxFreq && totImpressions > 300)
        pauseReason = `fatiga creativa (freq ${avgFreq.toFixed(1)}x > ${maxFreq})`;
      else if (totSpend >= minSpend && totClicks === 0)
        pauseReason = `sin clicks ($${totSpend.toFixed(0)} gastado)`;
      else if (avgCtr < minCtr && totSpend >= minSpend * 1.5)
        pauseReason = `CTR bajo (${avgCtr.toFixed(2)}% < ${minCtr}%)`;
      else if (targetCpl > 0 && totLeads > 0 && cpl > targetCpl * cplMult && totSpend > 20)
        pauseReason = `CPL alto ($${cpl.toFixed(0)} vs objetivo $${targetCpl} × ${cplMult})`;

      // Determine winner
      const isLeadWinner = targetCpl > 0 && totLeads >= 3 && cpl > 0 && cpl <= targetCpl * 0.7;
      const isCtrWinner  = avgCtr >= 1.5 && (avgRoas >= 2 || totConversions >= 3);
      const isWinner     = (isLeadWinner || isCtrWinner) && !pauseReason;

      if (pauseReason) {
        try {
          await metaPatch(token, ad.id, { status: 'PAUSED' });
          await sbReq('PATCH', `meta_ads?id=eq.${ad.id}`, { status: 'PAUSED', updated_at: new Date().toISOString() });
          actions.push({ id: ad.id, name: ad.name, action: 'paused', reason: pauseReason, spend: totSpend });
          await pushNotify('⏸ Meta: Anuncio pausado', `${ad.name}\nMotivo: ${pauseReason}`);
        } catch (e) { skipped.push({ id: ad.id, reason: e.message }); }

      } else if (isWinner) {
        const adsetRows = await sbGet(`meta_adsets?id=eq.${ad.adset_id}&select=id,budget_daily,updated_at`);
        if (!adsetRows.length) { skipped.push({ id: ad.id, reason: 'adset_missing' }); continue; }
        const adset = adsetRows[0];
        const daysSinceScale = (today - new Date(adset.updated_at)) / 86400000;
        if (daysSinceScale < 4) { skipped.push({ id: ad.id, reason: 'scale_too_soon', days: daysSinceScale.toFixed(1) }); continue; }

        const newBudget = adset.budget_daily ? Math.round(parseFloat(adset.budget_daily) * 1.25 * 100) : null;
        if (newBudget) {
          try {
            await metaPatch(token, adset.id, { daily_budget: newBudget });
            await sbReq('PATCH', `meta_adsets?id=eq.${adset.id}`, { budget_daily: newBudget / 100, updated_at: new Date().toISOString() });
            const winDetail = isLeadWinner
              ? `${totLeads} leads · CPL $${cpl.toFixed(0)}`
              : `CTR ${avgCtr.toFixed(2)}% · ROAS ${avgRoas.toFixed(1)}x`;
            actions.push({ id: ad.id, name: ad.name, action: 'scaled_+25%', new_budget_ars: newBudget / 100, detail: winDetail });
            await pushNotify('📈 Meta: Presupuesto escalado +25%', `${ad.name}\n${winDetail} → $${(newBudget/100).toLocaleString('es-AR')}/día`);
          } catch (e) { skipped.push({ id: ad.id, reason: e.message }); }
        }
      }
    }

    // Push resumen si hubo acciones
    if (actions.length > 0) {
      const paused  = actions.filter(a => a.action === 'paused').length;
      const scaled  = actions.filter(a => a.action === 'scaled_+25%').length;
      const summary = [paused > 0 ? `${paused} pausado${paused > 1 ? 's' : ''}` : null, scaled > 0 ? `${scaled} escalado${scaled > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
      await pushNotify('🤖 Meta agente — resumen', summary);
    }

    // persist last run summary for dashboard
    await sbReq('POST', 'rhinos_config?on_conflict=key', [{
      key: 'meta_agent_last_run',
      value: JSON.stringify({ ts: new Date().toISOString(), actions: actions.slice(0, 20), skipped_count: skipped.length }),
    }]).catch(() => {});

    return res.status(200).json({ ok: true, actions, skipped, _v: 'agent-v2' });
  } catch (err) {
    console.error('[meta-agent]', err.message);
    return res.status(200).json({ ok: false, error: err.message, actions, skipped, _v: 'agent-v2' });
  }
}

// ── CREATE AD ─────────────────────────────────────────────────────────────────
async function runCreateAd(req, res) {
  try {
    const cfg       = await getMetaConfig();
    const token     = cfg.meta_access_token  || '';
    const rawId     = cfg.meta_ad_account_id || '';
    const pageId    = cfg.meta_page_id       || '';
    const accountId = rawId.replace(/^act_/i, '');

    if (!token || token === 'pending' || !accountId)
      return res.status(200).json({ ok: false, error: 'Meta no configurado — guardá token y account ID' });
    if (!pageId)
      return res.status(200).json({ ok: false, error: 'Page ID no configurado. Agregalo en Configuración → Meta.' });

    const { adset_id, campaign_id, image_b64, image_name, ad_name, link_url, headline, body_text, cta_type } = req.body || {};
    if (!adset_id || !image_b64)
      return res.status(200).json({ ok: false, error: 'adset_id e image_b64 son requeridos' });

    // 1. Upload image
    const imgResult = await metaPost(token, `act_${accountId}/adimages`, {
      bytes: image_b64,
      name: image_name || 'creative.jpg',
    });
    const imgHash = Object.values(imgResult.images || {})[0]?.hash;
    if (!imgHash) throw new Error('Meta no devolvió el hash de la imagen');

    // 2. Create ad creative
    const creative = await metaPost(token, `act_${accountId}/adcreatives`, {
      name: ad_name || 'Creativo ' + Date.now(),
      object_story_spec: {
        page_id: pageId,
        link_data: {
          image_hash: imgHash,
          link: link_url || 'https://rhinosapp.vercel.app',
          message: body_text || '',
          name: headline || '',
          call_to_action: { type: cta_type || 'LEARN_MORE' },
        },
      },
    });

    // 3. Create ad (starts ACTIVE)
    const ad = await metaPost(token, `act_${accountId}/ads`, {
      name: ad_name || 'Anuncio ' + Date.now(),
      adset_id,
      creative: { creative_id: creative.id },
      status: 'ACTIVE',
    });

    // 4. Insert into Supabase so it shows immediately without waiting for cron sync
    await sbReq('POST', 'meta_ads?on_conflict=id', [{
      id: ad.id, adset_id, campaign_id: campaign_id || null,
      name: ad_name || 'Anuncio ' + Date.now(), status: 'ACTIVE',
      creative_id: creative.id, thumbnail_url: null,
      updated_at: new Date().toISOString(),
    }]).catch(() => {}); // non-fatal

    return res.status(200).json({ ok: true, ad_id: ad.id, creative_id: creative.id, image_hash: imgHash });
  } catch (err) {
    console.error('[meta-create-ad]', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── TOGGLE AD ─────────────────────────────────────────────────────────────────
async function runToggleAd(req, res) {
  try {
    const cfg   = await getMetaConfig();
    const token = cfg.meta_access_token || '';
    if (!token || token === 'pending')
      return res.status(200).json({ ok: false, error: 'Meta no configurado' });

    const { ad_id, new_status } = req.body || {};
    if (!ad_id || !new_status)
      return res.status(200).json({ ok: false, error: 'ad_id y new_status son requeridos' });

    await metaPatch(token, ad_id, { status: new_status });
    await sbReq('PATCH', `meta_ads?id=eq.${ad_id}`, { status: new_status, updated_at: new Date().toISOString() });

    return res.status(200).json({ ok: true, ad_id, new_status });
  } catch (err) {
    console.error('[meta-toggle-ad]', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── BULK TOGGLE ───────────────────────────────────────────────────────────────
async function runBulkToggle(req, res) {
  try {
    const cfg   = await getMetaConfig();
    const token = cfg.meta_access_token || '';
    if (!token || token === 'pending')
      return res.status(200).json({ ok: false, error: 'Meta no configurado' });

    const { ids, status } = req.body || {};
    if (!ids?.length || !status)
      return res.status(200).json({ ok: false, error: 'ids y status son requeridos' });

    let updated = 0;
    for (const ad_id of ids) {
      try {
        await metaPatch(token, ad_id, { status });
        await sbReq('PATCH', `meta_ads?id=eq.${ad_id}`, { status, updated_at: new Date().toISOString() });
        updated++;
      } catch(e) {
        console.warn(`[bulk-toggle] skip ${ad_id}: ${e.message}`);
      }
    }
    return res.status(200).json({ ok: true, updated });
  } catch (err) {
    console.error('[meta-bulk-toggle]', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── LEAD WEBHOOK ─────────────────────────────────────────────────────────────
async function runWebhook(req, res) {
  // GET: verificación inicial de Meta
  if (req.method === 'GET') {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    let verifyToken = 'rhinos_meta_webhook_2026';
    try { const cfg = await getMetaConfig(); verifyToken = cfg.meta_webhook_verify_token || verifyToken; } catch(e) {}
    if (mode === 'subscribe' && token === verifyToken) return res.status(200).send(challenge);
    return res.status(403).json({ error: 'Token de verificación incorrecto' });
  }

  // POST: lead recibido desde Meta
  try {
    const cfg    = await getMetaConfig();
    const token  = cfg.meta_access_token || '';
    const entries = req.body?.entry || [];
    const saved  = [];

    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'leadgen') continue;
        const v = change.value || {};
        const leadgenId = v.leadgen_id;
        if (!leadgenId) continue;

        // Fetch lead details (nombre, teléfono, email, etc.)
        let leadData = {}, fields = {};
        if (token && token !== 'pending') {
          try {
            leadData = await metaGet(token, `${leadgenId}?fields=field_data,ad_id,adset_id,campaign_id,created_time`);
            for (const f of (leadData.field_data || [])) fields[f.name] = f.values?.[0] || '';
          } catch(e) {}
        }

        const nombre  = fields.full_name || fields.nombre || fields.name || '';
        const phone   = fields.phone_number || fields.phone || fields.telefono || '';
        const email   = fields.email || '';
        const empresa = fields.company || fields.empresa || '';
        const adId    = v.ad_id || leadData.ad_id || null;
        const campId  = v.campaign_id || leadData.campaign_id || null;

        // Guardar en rhinos_leads
        const leadNote = `Lead Meta ID: ${leadgenId}${adId ? '\nAd: ' + adId : ''}${campId ? '\nCampaña: ' + campId : ''}`;
        await sbReq('POST', 'rhinos_leads', [{
          name:        nombre || `Lead Meta ${leadgenId.slice(-6)}`,
          phone:       phone  || null,
          email:       email  || null,
          company:     empresa || null,
          source:      'meta_lead_form',
          status:      'nuevo',
          temperature: 'caliente',
          notes:       leadNote,
        }]).catch(() => {});

        // Guardar en meta_leads_wa (tabla de leads Meta)
        await sbReq('POST', 'meta_leads_wa?on_conflict=lead_id', [{
          lead_id:    leadgenId,
          ad_id:      adId,
          campaign_id: campId,
          nombre, telefono: phone, email,
          fecha_lead: new Date((v.created_time || Date.now() / 1000) * 1000).toISOString(),
        }]).catch(() => {});

        saved.push({ leadgen_id: leadgenId, nombre, phone });
        await pushNotify('🎯 Nuevo lead de Meta!', `${nombre || 'Sin nombre'}\n${phone || email || 'Sin contacto'}`);
      }
    }
    return res.status(200).json({ ok: true, saved });
  } catch (err) {
    console.error('[meta-webhook]', err.message);
    return res.status(200).json({ ok: false, error: err.message }); // siempre 200 para webhooks
  }
}

// ── SYNC HISTÓRICO ────────────────────────────────────────────────────────────
async function runSyncHistorical(req, res) {
  const days = Math.min(parseInt(req.query?.days || req.body?.days || 30), 180);
  const start = Date.now();
  const log = [];
  try {
    const cfg = await getMetaConfig();
    const token = cfg.meta_access_token || '';
    const rawId = cfg.meta_ad_account_id || '';
    const accountId = rawId.replace(/^act_/i, '');
    if (!token || token === 'pending' || !accountId)
      return res.status(200).json({ ok: false, msg: 'Meta not configured' });

    const today = new Date();
    const since = new Date(today); since.setDate(since.getDate() - days);
    const timeRange = encodeURIComponent(JSON.stringify({ since: isoDate(since), until: isoDate(today) }));
    const fields = 'campaign_id,adset_id,ad_id,impressions,clicks,spend,reach,ctr,cpc,cpm,frequency,actions,cost_per_action_type,purchase_roas';
    const metricsData = await metaGet(token, `act_${accountId}/insights?level=ad&fields=${fields}&time_range=${timeRange}&time_increment=1&limit=2000`);
    const metrics = metricsData.data || [];
    log.push(`rows fetched: ${metrics.length}`);

    if (metrics.length) {
      const rows = metrics.map(m => {
        const conversions      = parseInt((m.actions || []).find(a => a.action_type === 'purchase')?.value || 0);
        const leads            = parseInt((m.actions || []).find(a => a.action_type === 'lead')?.value || 0);
        const messages_started = parseInt((m.actions || []).find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || 0);
        const cpa          = parseFloat((m.cost_per_action_type || []).find(a => a.action_type === 'purchase')?.value || 0);
        const cost_per_lead = parseFloat((m.cost_per_action_type || []).find(a => a.action_type === 'lead')?.value || 0);
        const roas         = parseFloat((m.purchase_roas || []).find(a => a.action_type === 'omni_purchase')?.value || 0);
        return {
          entity_type: 'ad', entity_id: m.ad_id, date_start: m.date_start,
          impressions: parseInt(m.impressions || 0), clicks: parseInt(m.clicks || 0),
          spend: parseFloat(m.spend || 0), reach: parseInt(m.reach || 0),
          ctr: parseFloat(m.ctr || 0), cpc: parseFloat(m.cpc || 0), cpm: parseFloat(m.cpm || 0),
          frequency: parseFloat(m.frequency || 0),
          conversions, cost_per_result: cpa, roas, leads, messages_started, cost_per_lead,
          raw_data: m, synced_at: new Date().toISOString(),
        };
      });
      for (let i = 0; i < rows.length; i += 200) {
        await sbReq('POST', 'meta_ad_metrics?on_conflict=entity_type,entity_id,date_start', rows.slice(i, i + 200));
      }
      log.push(`rows upserted: ${rows.length}`);
    }
    return res.status(200).json({ ok: true, log, days, ms: Date.now() - start });
  } catch(err) {
    console.error('[meta-sync-historical]', err.message);
    return res.status(200).json({ ok: false, error: err.message, log, ms: Date.now() - start });
  }
}

// ── PACING CHECK ──────────────────────────────────────────────────────────────
async function runPacingCheck(res) {
  const alerts = [];
  try {
    const cfg = await getMetaConfig();
    const token = cfg.meta_access_token || '';
    if (!token || token === 'pending') return res.status(200).json({ ok: false, msg: 'Meta not configured', alerts });

    const today = isoDate(new Date());
    const hourUTC = new Date().getUTCHours();
    const dayProgress = hourUTC / 24;
    if (dayProgress < 0.2) return res.status(200).json({ ok: true, msg: 'Too early', alerts: [], checked: 0 });

    const [adsets, ads, metrics] = await Promise.all([
      sbGet('meta_adsets?status=eq.ACTIVE&budget_daily=not.is.null&select=id,name,budget_daily'),
      sbGet('meta_ads?select=id,adset_id'),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=eq.${today}&select=entity_id,spend`),
    ]);

    const adToAdset = {};
    for (const a of ads) adToAdset[a.id] = a.adset_id;
    const adsetSpend = {};
    for (const m of metrics) {
      const asId = adToAdset[m.entity_id];
      if (asId) adsetSpend[asId] = (adsetSpend[asId] || 0) + parseFloat(m.spend || 0);
    }

    for (const as of adsets) {
      const spend  = adsetSpend[as.id] || 0;
      const budget = parseFloat(as.budget_daily || 0);
      if (!budget || budget < 100) continue;
      const pacing = spend / budget;

      if (pacing < dayProgress * 0.35 && dayProgress > 0.3) {
        alerts.push({ type: 'underpacing', name: as.name, pct: Math.round(pacing * 100), budget });
        await pushNotify('⚠️ Meta: Presupuesto subutilizado', `${as.name}\nUsó ${Math.round(pacing*100)}% a esta hora ($${spend.toFixed(0)} / $${budget.toFixed(0)})`);
      } else if (pacing > 0.88 && dayProgress < 0.75) {
        alerts.push({ type: 'overpacing', name: as.name, pct: Math.round(pacing * 100), budget });
        await pushNotify('🔴 Meta: Presupuesto casi agotado', `${as.name}\n${Math.round(pacing*100)}% gastado — puede dejar de publicarse`);
      }
    }

    // CTR drop alert: compare today's CTR vs 7-day average per active ad
    if (dayProgress > 0.4) {
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const since7 = new Date(); since7.setDate(since7.getDate() - 7);
      const [todayMetrics, histMetrics] = await Promise.all([
        sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=eq.${today}&select=entity_id,clicks,impressions`),
        sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${isoDate(since7)}&date_start=lte.${isoDate(yesterday)}&select=entity_id,clicks,impressions`),
      ]);
      const hist7 = {};
      for (const m of histMetrics) {
        if (!hist7[m.entity_id]) hist7[m.entity_id] = { clicks: 0, impressions: 0 };
        hist7[m.entity_id].clicks += parseInt(m.clicks || 0);
        hist7[m.entity_id].impressions += parseInt(m.impressions || 0);
      }
      for (const m of todayMetrics) {
        const todayCtr = m.impressions > 50 ? (parseInt(m.clicks||0) / parseInt(m.impressions)) * 100 : null;
        const h = hist7[m.entity_id];
        if (!todayCtr || !h || h.impressions < 500) continue;
        const avg7Ctr = (h.clicks / h.impressions) * 100;
        if (avg7Ctr > 0.3 && todayCtr < avg7Ctr * 0.6) {
          const adRow = ads.find(a => a.id === m.entity_id) || { id: m.entity_id };
          const adName = adRow.adset_id ? (await sbGet(`meta_ads?id=eq.${m.entity_id}&select=name`).catch(()=>[]))[0]?.name || m.entity_id : m.entity_id;
          alerts.push({ type: 'ctr_drop', entity_id: m.entity_id, today_ctr: todayCtr.toFixed(2), avg7_ctr: avg7Ctr.toFixed(2) });
          await pushNotify('📉 Meta: CTR cayó hoy', `${adName}\nHoy ${todayCtr.toFixed(2)}% vs promedio ${avg7Ctr.toFixed(2)}% (7d)`);
        }
      }
    }

    return res.status(200).json({ ok: true, alerts, checked: adsets.length, day_pct: Math.round(dayProgress * 100) });
  } catch(err) {
    console.error('[meta-pacing]', err.message);
    return res.status(200).json({ ok: false, error: err.message, alerts });
  }
}

// ── DUPLICATE AD ──────────────────────────────────────────────────────────────
async function runDuplicateAd(req, res) {
  try {
    const cfg = await getMetaConfig();
    const token = cfg.meta_access_token || '';
    const rawId = cfg.meta_ad_account_id || '';
    const accountId = rawId.replace(/^act_/i, '');
    if (!token || token === 'pending' || !accountId)
      return res.status(200).json({ ok: false, error: 'Meta no configurado' });

    const { ad_id, new_name } = req.body || {};
    if (!ad_id) return res.status(200).json({ ok: false, error: 'ad_id requerido' });

    const original = await metaGet(token, `${ad_id}?fields=name,adset_id,campaign_id,creative{id}`);
    const creativeId = original.creative?.id;
    if (!creativeId) return res.status(200).json({ ok: false, error: 'No se encontró el creative del anuncio original' });

    const finalName = new_name || (original.name + ' (copia)');
    const newAd = await metaPost(token, `act_${accountId}/ads`, {
      name: finalName,
      adset_id: original.adset_id,
      creative: { creative_id: creativeId },
      status: 'PAUSED',
    });

    await sbReq('POST', 'meta_ads?on_conflict=id', [{
      id: newAd.id,
      adset_id: original.adset_id,
      campaign_id: original.campaign_id || null,
      name: finalName, status: 'PAUSED',
      creative_id: creativeId,
      updated_at: new Date().toISOString(),
    }]).catch(() => {});

    return res.status(200).json({ ok: true, ad_id: newAd.id, name: finalName });
  } catch(err) {
    console.error('[meta-duplicate-ad]', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── TOGGLE ADSET ─────────────────────────────────────────────────────────────
async function runToggleAdset(req, res) {
  try {
    const cfg = await getMetaConfig();
    const token = cfg.meta_access_token || '';
    if (!token || token === 'pending')
      return res.status(200).json({ ok: false, error: 'Meta no configurado' });
    const { adset_id, new_status } = req.body || {};
    if (!adset_id || !new_status)
      return res.status(200).json({ ok: false, error: 'adset_id y new_status son requeridos' });
    await metaPatch(token, adset_id, { status: new_status });
    await sbReq('PATCH', `meta_adsets?id=eq.${adset_id}`, { status: new_status, updated_at: new Date().toISOString() });
    return res.status(200).json({ ok: true, adset_id, new_status });
  } catch (err) {
    console.error('[meta-toggle-adset]', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── UPDATE BUDGET ─────────────────────────────────────────────────────────────
async function runUpdateBudget(req, res) {
  try {
    const cfg = await getMetaConfig();
    const token = cfg.meta_access_token || '';
    if (!token || token === 'pending')
      return res.status(200).json({ ok: false, error: 'Meta no configurado' });
    const { entity_type, entity_id, daily_budget } = req.body || {};
    if (!entity_id || !entity_type || daily_budget == null)
      return res.status(200).json({ ok: false, error: 'entity_type, entity_id y daily_budget requeridos' });
    const budgetCents = Math.round(parseFloat(daily_budget) * 100);
    await metaPatch(token, entity_id, { daily_budget: budgetCents });
    const table = entity_type === 'campaign' ? 'meta_campaigns' : 'meta_adsets';
    await sbReq('PATCH', `${table}?id=eq.${entity_id}`, { budget_daily: parseFloat(daily_budget), updated_at: new Date().toISOString() });
    return res.status(200).json({ ok: true, entity_id, daily_budget: parseFloat(daily_budget) });
  } catch (err) {
    console.error('[meta-update-budget]', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── LEAD QUALITY ──────────────────────────────────────────────────────────────
async function runLeadQuality(res) {
  try {
    const [metaLeads, rhinosLeads, ads] = await Promise.all([
      sbGet('meta_leads_wa?select=id,ad_id,telefono,estado&limit=2000'),
      sbGet('rhinos_leads?select=phone,status&limit=5000'),
      sbGet('meta_ads?select=id,name&limit=500'),
    ]);

    const adNameMap = {};
    for (const a of ads) adNameMap[a.id] = a.name;

    // Build set of phones that advanced past "nuevo"
    const advancedPhones = new Set();
    for (const l of rhinosLeads) {
      if (l.phone && !['nuevo','sin_respuesta'].includes(l.status)) advancedPhones.add(l.phone.replace(/\D/g,''));
    }

    const byAd = {};
    for (const ml of metaLeads) {
      const id = ml.ad_id || 'unknown';
      if (!byAd[id]) byAd[id] = { total: 0, advanced: 0, name: adNameMap[id] || id };
      byAd[id].total++;
      const phone = (ml.telefono || '').replace(/\D/g,'');
      if (phone && advancedPhones.has(phone)) byAd[id].advanced++;
    }

    const result = Object.entries(byAd)
      .map(([id, v]) => ({ ad_id: id, name: v.name, total_leads: v.total, advanced: v.advanced, quality_pct: v.total > 0 ? Math.round(v.advanced / v.total * 100) : 0 }))
      .sort((a, b) => b.quality_pct - a.quality_pct);

    return res.status(200).json({ ok: true, result, total_leads: metaLeads.length });
  } catch(err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── TODAY REPORT ──────────────────────────────────────────────────────────────
async function runTodayReport(res) {
  try {
    const today = isoDate(new Date());
    const yesterday = isoDate(new Date(Date.now() - 86400000));
    const weekAgo   = isoDate(new Date(Date.now() - 7 * 86400000));

    const [todayRows, yestRows, weekRows] = await Promise.all([
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=eq.${today}&select=spend,impressions,clicks,leads,messages_started`),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=eq.${yesterday}&select=spend,impressions,clicks,leads,messages_started`),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${weekAgo}&date_start=lt.${today}&select=spend,impressions,clicks,leads,messages_started,date_start`),
    ]);

    const agg = (rows) => rows.reduce((a, r) => ({
      spend: a.spend + parseFloat(r.spend || 0),
      impressions: a.impressions + parseInt(r.impressions || 0),
      clicks: a.clicks + parseInt(r.clicks || 0),
      leads: a.leads + parseInt(r.leads || 0),
      messages: a.messages + parseInt(r.messages_started || 0),
    }), { spend: 0, impressions: 0, clicks: 0, leads: 0, messages: 0 });

    const sameDayLastWeek = weekRows.filter(r => r.date_start === weekAgo);

    return res.status(200).json({
      ok: true,
      today: agg(todayRows),
      yesterday: agg(yestRows),
      same_day_last_week: agg(sameDayLastWeek),
      week_avg: (rows => {
        const t = agg(rows); const n = 7;
        return { spend: t.spend/n, impressions: t.impressions/n, clicks: t.clicks/n, leads: t.leads/n, messages: t.messages/n };
      })(weekRows),
      date: today,
    });
  } catch(err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}

export default async function handler(req, res) {
  const action = req.query?.action || 'sync';
  if (action === 'agent')             return runAgent(res);
  if (action === 'webhook')           return runWebhook(req, res);
  if (action === 'create_ad')         return runCreateAd(req, res);
  if (action === 'toggle_ad')         return runToggleAd(req, res);
  if (action === 'toggle_adset')      return runToggleAdset(req, res);
  if (action === 'update_budget')     return runUpdateBudget(req, res);
  if (action === 'bulk_toggle')       return runBulkToggle(req, res);
  if (action === 'sync_historical')   return runSyncHistorical(req, res);
  if (action === 'pacing_check')      return runPacingCheck(res);
  if (action === 'duplicate_ad')      return runDuplicateAd(req, res);
  if (action === 'today_report')      return runTodayReport(res);
  if (action === 'lead_quality')      return runLeadQuality(res);
  return runSync(res);
}
