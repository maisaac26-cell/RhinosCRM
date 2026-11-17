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

        // WA instant notification
        try {
          const [waRaw, adRaw] = await Promise.all([
            sbGet('rhinos_config?key=eq.wa_recipients&select=value'),
            adId ? sbGet(`meta_ads?id=eq.${adId}&select=name&limit=1`) : Promise.resolve([]),
          ]);
          let waList = [];
          if (waRaw[0]) { try { waList = JSON.parse(waRaw[0].value.replace(/^"|"$/g, '')); } catch(e) {} }
          if (waList.length) {
            const adName = adRaw[0]?.name || 'Desconocido';
            const hora   = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
            const msg    = `🔔 *Nuevo lead Meta*\n👤 ${nombre||'Sin nombre'}\n📱 ${phone||'Sin teléfono'}\n📢 ${adName.slice(0,30)}\n⏰ ${hora}`;
            await Promise.all(waList.map(r =>
              fetch(`https://api.callmebot.com/whatsapp.php?phone=${r.phone}&text=${encodeURIComponent(msg)}&apikey=${r.apikey}`).catch(() => {})
            ));
          }
        } catch(e) {}
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

// ── BUDGET RECOMMENDATIONS ────────────────────────────────────────────────────
async function runBudgetRecs(res) {
  try {
    const cfg    = await getMetaConfig();
    const targetCpl = parseFloat(cfg.meta_target_cpl || 0);
    const since7 = isoDate(new Date(Date.now() - 7 * 86400000));

    const [adsets, ads, metrics] = await Promise.all([
      sbGet('meta_adsets?status=eq.ACTIVE&budget_daily=not.is.null&select=id,name,budget_daily,campaign_id'),
      sbGet('meta_ads?select=id,adset_id'),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${since7}&select=entity_id,spend,impressions,clicks,leads,frequency`),
    ]);

    const adToAdset = {};
    for (const a of ads) adToAdset[a.id] = a.adset_id;

    const adsetAgg = {};
    for (const m of metrics) {
      const asId = adToAdset[m.entity_id];
      if (!asId) continue;
      if (!adsetAgg[asId]) adsetAgg[asId] = { spend:0, impressions:0, clicks:0, leads:0, freq_sum:0, freq_n:0 };
      adsetAgg[asId].spend += parseFloat(m.spend||0);
      adsetAgg[asId].impressions += parseInt(m.impressions||0);
      adsetAgg[asId].clicks += parseInt(m.clicks||0);
      adsetAgg[asId].leads += parseInt(m.leads||0);
      if (m.frequency) { adsetAgg[asId].freq_sum += parseFloat(m.frequency); adsetAgg[asId].freq_n++; }
    }

    const recs = [];
    for (const as of adsets) {
      const agg = adsetAgg[as.id];
      if (!agg || agg.spend < 5) continue;
      const cpl = agg.leads > 0 ? agg.spend / agg.leads : 0;
      const ctr = agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : 0;
      const freq = agg.freq_n > 0 ? agg.freq_sum / agg.freq_n : 0;
      const budget = parseFloat(as.budget_daily || 0);

      if (targetCpl > 0 && cpl > 0 && cpl < targetCpl * 0.7 && freq < 2.5 && budget > 0) {
        recs.push({ type: 'increase', name: as.name, id: as.id, budget, cpl, ctr: ctr.toFixed(2), leads: agg.leads,
          reason: `CPL $${cpl.toFixed(0)} < 70% objetivo · freq ${freq.toFixed(1)} · ${agg.leads} leads`,
          suggested: Math.round(budget * 1.3) });
      } else if (agg.leads === 0 && agg.spend > 15 && ctr < 0.4) {
        recs.push({ type: 'decrease', name: as.name, id: as.id, budget, cpl: 0, ctr: ctr.toFixed(2), leads: 0,
          reason: `Sin leads · ${agg.spend.toFixed(0)} gastado · CTR ${ctr.toFixed(2)}%`,
          suggested: Math.round(budget * 0.6) });
      } else if (freq > 3.2 && budget > 0) {
        recs.push({ type: 'refresh', name: as.name, id: as.id, budget, cpl, ctr: ctr.toFixed(2), leads: agg.leads,
          reason: `Fatiga: freq ${freq.toFixed(1)} — renovar creativos` });
      }
    }
    return res.status(200).json({ ok: true, recs, analyzed: adsets.length });
  } catch(err) {
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

// ── ANOMALY CHECK ─────────────────────────────────────────────────────────────
async function runAnomalyCheck(res) {
  try {
    const today = isoDate(new Date());
    const since8 = isoDate(new Date(Date.now() - 8 * 86400000));
    const yesterday = isoDate(new Date(Date.now() - 86400000));

    const [todayM, weekM] = await Promise.all([
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=eq.${today}&select=spend,impressions,clicks,leads`),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${since8}&date_start=lte.${yesterday}&select=date_start,spend,impressions,clicks,leads`),
    ]);

    const sum = (arr, f) => arr.reduce((s, r) => s + parseFloat(r[f] || 0), 0);
    const tSpend = sum(todayM, 'spend'), tImpr = sum(todayM, 'impressions');
    const tClicks = sum(todayM, 'clicks'), tLeads = sum(todayM, 'leads');

    // aggregate 7d by day to get daily averages
    const byDay = {};
    for (const r of weekM) {
      if (!byDay[r.date_start]) byDay[r.date_start] = { spend: 0, impressions: 0, clicks: 0, leads: 0 };
      byDay[r.date_start].spend       += parseFloat(r.spend || 0);
      byDay[r.date_start].impressions += parseFloat(r.impressions || 0);
      byDay[r.date_start].clicks      += parseFloat(r.clicks || 0);
      byDay[r.date_start].leads       += parseFloat(r.leads || 0);
    }
    const nDays = Math.max(Object.keys(byDay).length, 1);
    const aSpend = sum(weekM, 'spend') / nDays;
    const aImpr  = sum(weekM, 'impressions') / nDays;
    const aClicks = sum(weekM, 'clicks') / nDays;
    const aLeads  = sum(weekM, 'leads') / nDays;

    const anomalies = [];
    if (aSpend > 50) {
      const r = tSpend / aSpend;
      if (r > 1.6) anomalies.push({ type: 'spike', metric: 'spend', label: 'Gasto inusualmente alto', today: tSpend, avg7: aSpend, ratio: r });
      else if (r < 0.4 && tSpend < 500) anomalies.push({ type: 'drop', metric: 'spend', label: 'Gasto muy bajo — revisar campañas', today: tSpend, avg7: aSpend, ratio: r });
    }
    if (aImpr > 300) {
      const r = tImpr / aImpr;
      if (r < 0.35) anomalies.push({ type: 'drop', metric: 'impressions', label: 'Caída brusca de impresiones', today: tImpr, avg7: aImpr, ratio: r });
    }
    if (aClicks > 10 && aImpr > 0 && tImpr > 0) {
      const ctrToday = tClicks / tImpr, ctrAvg = aClicks / aImpr;
      if (ctrAvg > 0 && ctrToday < ctrAvg * 0.45) anomalies.push({ type: 'drop', metric: 'ctr', label: 'CTR muy por debajo del promedio', today: ctrToday * 100, avg7: ctrAvg * 100, ratio: ctrToday / ctrAvg });
    }
    if (aLeads > 0.5 && tSpend > aSpend * 0.5) {
      if (tLeads === 0) anomalies.push({ type: 'warn', metric: 'leads', label: 'Sin leads hoy con gasto activo', today: 0, avg7: aLeads, ratio: 0 });
    }

    return res.status(200).json({ ok: true, anomalies, today: { spend: tSpend, impressions: tImpr, clicks: tClicks, leads: tLeads }, avg7: { spend: aSpend, impressions: aImpr, clicks: aClicks, leads: aLeads } });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
}

// ── MONTHLY GOALS ─────────────────────────────────────────────────────────────
async function runMonthlyGoals(res) {
  try {
    const now = new Date();
    const monthStart = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
    const [metrics, cfg] = await Promise.all([
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${monthStart}&select=spend,leads,messages_started`),
      sbGet(`rhinos_config?key=in.(meta_goal_leads_month,meta_goal_spend_month)&select=key,value`),
    ]);
    const c = {}; for (const r of cfg) c[r.key] = parseFloat(String(r.value).replace(/^"|"$/g,'')) || 0;
    const totSpend = metrics.reduce((s, r) => s + parseFloat(r.spend || 0), 0);
    const totLeads = metrics.reduce((s, r) => s + parseInt(r.leads || 0), 0);
    const totMessages = metrics.reduce((s, r) => s + parseInt(r.messages_started || 0), 0);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const pctMonth = dayOfMonth / daysInMonth;
    return res.status(200).json({ ok: true, totSpend, totLeads, totMessages, pctMonth, dayOfMonth, daysInMonth, goalLeads: c.meta_goal_leads_month, goalSpend: c.meta_goal_spend_month });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
}

// ── WEEK-OVER-WEEK METRICS ───────────────────────────────────────────────────
async function runWoWMetrics(res) {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun
    const startOfThisWeek = new Date(now); startOfThisWeek.setDate(now.getDate() - dayOfWeek);
    const startOfLastWeek = new Date(startOfThisWeek); startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);
    const endOfLastWeek   = new Date(startOfThisWeek); endOfLastWeek.setDate(startOfThisWeek.getDate() - 1);

    const tw = isoDate(startOfThisWeek), lw0 = isoDate(startOfLastWeek), lw1 = isoDate(endOfLastWeek);

    const [thisW, lastW] = await Promise.all([
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${tw}&select=spend,impressions,clicks,leads,messages_started`),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${lw0}&date_start=lte.${lw1}&select=spend,impressions,clicks,leads,messages_started`),
    ]);

    const agg = rows => ({
      spend:    rows.reduce((s, r) => s + parseFloat(r.spend||0), 0),
      impressions: rows.reduce((s, r) => s + parseInt(r.impressions||0), 0),
      clicks:   rows.reduce((s, r) => s + parseInt(r.clicks||0), 0),
      leads:    rows.reduce((s, r) => s + parseInt(r.leads||0), 0),
      messages: rows.reduce((s, r) => s + parseInt(r.messages_started||0), 0),
    });

    const tw_agg = agg(thisW), lw_agg = agg(lastW);
    const diff = key => lw_agg[key] > 0 ? ((tw_agg[key] - lw_agg[key]) / lw_agg[key]) * 100 : null;

    return res.status(200).json({ ok: true, thisWeek: tw_agg, lastWeek: lw_agg, diff: { spend: diff('spend'), impressions: diff('impressions'), clicks: diff('clicks'), leads: diff('leads'), messages: diff('messages') } });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
}

// ── CREATIVE LEADERBOARD ─────────────────────────────────────────────────────
async function runLeaderboard(res) {
  try {
    const since30 = isoDate(new Date(Date.now() - 30 * 86400000));
    const [ads, metrics, leads] = await Promise.all([
      sbGet('meta_ads?select=id,name,status,campaign_id,adset_id&limit=300'),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${since30}&select=entity_id,spend,impressions,clicks,leads,messages_started,frequency`),
      sbGet('meta_leads_wa?select=ad_id&limit=2000').catch(() => []),
    ]);

    const leadCount = {};
    for (const l of leads) if (l.ad_id) leadCount[l.ad_id] = (leadCount[l.ad_id] || 0) + 1;

    const byAd = {};
    for (const m of metrics) {
      if (!byAd[m.entity_id]) byAd[m.entity_id] = { spend:0, impressions:0, clicks:0, leads:0, messages:0, freq_sum:0, freq_n:0 };
      byAd[m.entity_id].spend       += parseFloat(m.spend||0);
      byAd[m.entity_id].impressions += parseInt(m.impressions||0);
      byAd[m.entity_id].clicks      += parseInt(m.clicks||0);
      byAd[m.entity_id].leads       += parseInt(m.leads||0);
      byAd[m.entity_id].messages    += parseInt(m.messages_started||0);
      if (m.frequency) { byAd[m.entity_id].freq_sum += parseFloat(m.frequency); byAd[m.entity_id].freq_n++; }
    }

    const rows = ads.map(ad => {
      const m = byAd[ad.id] || {};
      const ctr = (m.impressions||0) > 0 ? m.clicks / m.impressions * 100 : 0;
      const cpl = (m.leads||0) > 0 ? m.spend / m.leads : 0;
      const freq = m.freq_n > 0 ? m.freq_sum / m.freq_n : 0;
      const wh_leads = leadCount[ad.id] || 0;
      // health score (0-100)
      let score = 50;
      if (ctr > 1.5) score += 20; else if (ctr > 0.8) score += 10; else if (ctr < 0.3) score -= 20;
      if ((m.leads||0) > 0) score += 15; if ((m.leads||0) > 3) score += 5;
      if (cpl > 0 && cpl < 5000) score += 10; else if (cpl > 20000) score -= 15;
      if (freq > 3.5) score -= 20; else if (freq > 2.5) score -= 10;
      if (ad.status !== 'ACTIVE') score -= 10;
      score = Math.max(0, Math.min(100, score));
      return { id: ad.id, name: ad.name, status: ad.status, campaign_id: ad.campaign_id, spend: m.spend||0, impressions: m.impressions||0, clicks: m.clicks||0, leads: m.leads||0, messages: m.messages||0, ctr, cpl, freq, score, wh_leads };
    }).sort((a, b) => b.score - a.score);

    return res.status(200).json({ ok: true, rows: rows.slice(0, 100), total: rows.length });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
}

// ── CREATIVE DECAY DETECTION ─────────────────────────────────────────────────
async function runDecayCheck(res) {
  try {
    const today   = isoDate(new Date());
    const d7      = isoDate(new Date(Date.now() - 7 * 86400000));
    const d14     = isoDate(new Date(Date.now() - 14 * 86400000));

    const [recent, prior, ads] = await Promise.all([
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${d7}&date_start=lte.${today}&select=entity_id,spend,impressions,clicks,leads`),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${d14}&date_start=lt.${d7}&select=entity_id,spend,impressions,clicks,leads`),
      sbGet('meta_ads?select=id,name,status&limit=300'),
    ]);

    const adMap = {}; for (const a of ads) adMap[a.id] = a;

    const agg = (rows) => {
      const m = {};
      for (const r of rows) {
        if (!m[r.entity_id]) m[r.entity_id] = { spend:0, impressions:0, clicks:0, leads:0 };
        m[r.entity_id].spend       += parseFloat(r.spend||0);
        m[r.entity_id].impressions += parseInt(r.impressions||0);
        m[r.entity_id].clicks      += parseInt(r.clicks||0);
        m[r.entity_id].leads       += parseInt(r.leads||0);
      }
      return m;
    };

    const rM = agg(recent), pM = agg(prior);
    const decaying = [];

    for (const [id, r] of Object.entries(rM)) {
      const p = pM[id];
      if (!p) continue;
      const ad = adMap[id];
      if (!ad || ad.status !== 'ACTIVE') continue;
      if (r.spend < 5 || p.spend < 5) continue;

      const ctrR = r.impressions > 0 ? r.clicks / r.impressions * 100 : 0;
      const ctrP = p.impressions > 0 ? p.clicks / p.impressions * 100 : 0;
      if (ctrP < 0.1) continue;

      const ctrDrop = (ctrP - ctrR) / ctrP;
      const leadsDrop = p.leads > 0 && r.leads === 0;

      if (ctrDrop > 0.35 || (leadsDrop && p.leads >= 2)) {
        decaying.push({
          id,
          name: ad.name,
          ctrRecent: ctrR,
          ctrPrior: ctrP,
          ctrDrop: ctrDrop * 100,
          leadsRecent: r.leads,
          leadsPrior: p.leads,
          spendRecent: r.spend,
          leadsDrop,
        });
      }
    }

    decaying.sort((a, b) => b.ctrDrop - a.ctrDrop);
    return res.status(200).json({ ok: true, decaying: decaying.slice(0, 10), analyzed: Object.keys(rM).length });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
}

// ── ADSET EFFICIENCY ─────────────────────────────────────────────────────────
async function runAdsetEfficiency(res) {
  try {
    const since30 = isoDate(new Date(Date.now() - 30 * 86400000));
    const [adsets, metrics] = await Promise.all([
      sbGet('meta_adsets?select=id,name,status,budget_daily,campaign_id&limit=200'),
      sbGet(`meta_ad_metrics?entity_type=eq.adset&date_start=gte.${since30}&select=entity_id,spend,impressions,clicks,leads,messages_started`),
    ]);

    const byAdset = {};
    for (const m of metrics) {
      if (!byAdset[m.entity_id]) byAdset[m.entity_id] = { spend:0, impressions:0, clicks:0, leads:0, messages:0 };
      byAdset[m.entity_id].spend       += parseFloat(m.spend||0);
      byAdset[m.entity_id].impressions += parseInt(m.impressions||0);
      byAdset[m.entity_id].clicks      += parseInt(m.clicks||0);
      byAdset[m.entity_id].leads       += parseInt(m.leads||0);
      byAdset[m.entity_id].messages    += parseInt(m.messages_started||0);
    }

    const rows = adsets.map(a => {
      const m = byAdset[a.id] || {};
      const ctr = m.impressions > 0 ? m.clicks / m.impressions * 100 : 0;
      const cpl = m.leads > 0 ? m.spend / m.leads : null;
      const efficiency = m.leads > 0 && m.spend > 0 ? m.leads / m.spend * 1000 : 0; // leads per 1k ARS
      return { id: a.id, name: a.name, status: a.status, budget: a.budget_daily, campaign_id: a.campaign_id, spend: m.spend||0, leads: m.leads||0, messages: m.messages||0, ctr, cpl, efficiency };
    }).sort((a, b) => b.efficiency - a.efficiency);

    return res.status(200).json({ ok: true, rows: rows.slice(0, 50), total: rows.length });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
}

async function runMorningBrief(res) {
  try {
    const yesterday = isoDate(new Date(Date.now() - 86400000));
    const since7    = isoDate(new Date(Date.now() - 6 * 86400000));

    const [yMetrics, w7Metrics, ads, cfgGoals, cfgWa] = await Promise.all([
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=eq.${yesterday}&select=entity_id,spend,impressions,clicks,leads,messages_started`),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${since7}&select=entity_id,spend,leads`),
      sbGet('meta_ads?select=id,name&limit=200'),
      sbGet('rhinos_config?key=in.(meta_goal_leads_month,meta_goal_spend_month)&select=key,value'),
      sbGet('rhinos_config?key=eq.wa_recipients&select=value'),
    ]);

    let WA_RECIPIENTS = [];
    if (cfgWa[0]) {
      try { WA_RECIPIENTS = JSON.parse(cfgWa[0].value.replace(/^"|"$/g,'')); } catch(e) {}
    }
    if (!WA_RECIPIENTS.length) return res.status(200).json({ ok: false, msg: 'No wa_recipients configured' });

    const adNameMap = {}; for (const a of ads) adNameMap[a.id] = a.name;
    const cfgMap = {}; for (const c of cfgGoals) cfgMap[c.key] = parseFloat(c.value) || 0;

    const yAgg = {}, w7Agg = {};
    for (const m of yMetrics) {
      if (!yAgg[m.entity_id]) yAgg[m.entity_id] = { spend:0, impressions:0, clicks:0, leads:0, messages:0 };
      yAgg[m.entity_id].spend       += parseFloat(m.spend||0);
      yAgg[m.entity_id].impressions += parseInt(m.impressions||0);
      yAgg[m.entity_id].clicks      += parseInt(m.clicks||0);
      yAgg[m.entity_id].leads       += parseInt(m.leads||0);
      yAgg[m.entity_id].messages    += parseInt(m.messages_started||0);
    }
    for (const m of w7Metrics) {
      if (!w7Agg[m.entity_id]) w7Agg[m.entity_id] = { spend:0, leads:0 };
      w7Agg[m.entity_id].spend += parseFloat(m.spend||0);
      w7Agg[m.entity_id].leads += parseInt(m.leads||0);
    }

    const yTotSpend = Object.values(yAgg).reduce((s,a) => s + a.spend, 0);
    const yTotLeads = Object.values(yAgg).reduce((s,a) => s + a.leads, 0);
    const yTotImpr  = Object.values(yAgg).reduce((s,a) => s + a.impressions, 0);
    const yTotMsg   = Object.values(yAgg).reduce((s,a) => s + a.messages, 0);
    const w7Leads   = Object.values(w7Agg).reduce((s,a) => s + a.leads, 0);

    const yCandidates = Object.entries(yAgg).filter(([,m]) => m.spend > 1);
    const bestYAd  = yCandidates.filter(([,m]) => m.leads > 0).sort((a,b) => (a[1].spend/a[1].leads) - (b[1].spend/b[1].leads))[0];
    const worstYAd = yCandidates.filter(([,m]) => m.leads === 0).sort((a,b) => b[1].spend - a[1].spend)[0];

    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const goalLeads = cfgMap['meta_goal_leads_month'] || 0;
    const avgDailyLeads = w7Leads / 7;

    const fechaAyer = new Date(Date.now() - 86400000).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'short' });
    const fA = n => '$' + Math.round(n).toLocaleString('es-AR');

    let msg = `🌅 *Buenos días — Meta Ads*\n`;
    msg += `📅 Ayer (${fechaAyer})\n`;
    msg += `━━━━━━━━━━━━━━━\n\n`;

    if (yTotSpend === 0) {
      msg += `Sin actividad registrada ayer.\n`;
    } else {
      msg += `💰 Gasto: ${fA(yTotSpend)}\n`;
      msg += `👁 Impresiones: ${yTotImpr.toLocaleString('es-AR')}\n`;
      if (yTotLeads > 0) msg += `🎯 Leads: ${yTotLeads} · CPL: ${fA(yTotSpend / yTotLeads)}\n`;
      else msg += `🎯 Leads: 0\n`;
      if (yTotMsg > 0) msg += `💬 Mensajes WA: ${yTotMsg}\n`;
    }
    if (bestYAd) {
      const [id, m] = bestYAd;
      msg += `\n🏆 Mejor ayer: ${(adNameMap[id]||id).slice(0,28)}\n`;
      msg += `   ${m.leads} leads · CPL ${fA(m.spend/m.leads)}\n`;
    }
    if (worstYAd) {
      const [id, m] = worstYAd;
      msg += `\n⚠️ Sin leads: ${(adNameMap[id]||id).slice(0,28)} (${fA(m.spend)} gastado)\n`;
    }
    if (goalLeads > 0) {
      const trend = Math.round(avgDailyLeads * daysInMonth);
      msg += `\n📊 Proyección: ~${trend} leads (meta: ${goalLeads})\n`;
    }
    msg += `\n💪 Que hoy sea un gran día 🦏`;

    for (const r of WA_RECIPIENTS) {
      await fetch(`https://api.callmebot.com/whatsapp.php?phone=${r.phone}&text=${encodeURIComponent(msg)}&apikey=${r.apikey}`).catch(() => {});
    }

    return res.status(200).json({ ok: true, sent: WA_RECIPIENTS.length, yTotLeads, yTotSpend: Math.round(yTotSpend) });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
}

async function runCplTrend(res) {
  try {
    const since8w = new Date(); since8w.setDate(since8w.getDate() - 55);
    const sinceStr = isoDate(since8w);
    const rows = await sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${sinceStr}&select=date_start,spend,leads`);

    const weeks = {};
    for (const r of rows) {
      const d = new Date(r.date_start);
      // ISO week: Monday-based
      const day = d.getDay() || 7;
      const mon = new Date(d); mon.setDate(d.getDate() - day + 1);
      const key = isoDate(mon);
      if (!weeks[key]) weeks[key] = { spend: 0, leads: 0 };
      weeks[key].spend += parseFloat(r.spend || 0);
      weeks[key].leads += parseInt(r.leads || 0);
    }

    const sorted = Object.entries(weeks)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-8)
      .map(([weekStart, m]) => ({
        weekStart,
        spend: Math.round(m.spend),
        leads: m.leads,
        cpl: m.leads > 0 ? Math.round(m.spend / m.leads) : null,
      }));

    return res.status(200).json({ ok: true, weeks: sorted });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
}

async function runAccountHealth(res) {
  try {
    const [cfg, metrics7, ads, goals] = await Promise.all([
      sbGet('rhinos_config?key=in.(meta_goal_leads_month,meta_goal_spend_month)&select=key,value'),
      sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${isoDate(new Date(Date.now()-6*86400000))}&select=entity_id,spend,impressions,clicks,leads,messages_started`),
      sbGet('meta_ads?status=eq.ACTIVE&select=id,name'),
      sbGet('rhinos_config?key=in.(meta_goal_leads_month,meta_goal_spend_month)&select=key,value'),
    ]);

    const cfgMap = {}; for (const c of cfg) cfgMap[c.key] = parseFloat(c.value) || 0;
    const goalLeads = cfgMap['meta_goal_leads_month'] || 0;
    const goalSpend = cfgMap['meta_goal_spend_month'] || 0;

    // Aggregate 7d totals
    const agg = {};
    for (const m of metrics7) {
      if (!agg[m.entity_id]) agg[m.entity_id] = { spend: 0, impressions: 0, clicks: 0, leads: 0 };
      agg[m.entity_id].spend       += parseFloat(m.spend || 0);
      agg[m.entity_id].impressions += parseInt(m.impressions || 0);
      agg[m.entity_id].clicks      += parseInt(m.clicks || 0);
      agg[m.entity_id].leads       += parseInt(m.leads || 0);
    }

    const totSpend = Object.values(agg).reduce((s, a) => s + a.spend, 0);
    const totLeads = Object.values(agg).reduce((s, a) => s + a.leads, 0);
    const totImpr  = Object.values(agg).reduce((s, a) => s + a.impressions, 0);
    const totClk   = Object.values(agg).reduce((s, a) => s + a.clicks, 0);
    const avgCtr   = totImpr > 0 ? totClk / totImpr * 100 : 0;

    // Score components (each 0-25)
    // 1. CTR health (benchmark 1.5%)
    const ctrScore = Math.min(25, Math.round(avgCtr / 1.5 * 25));

    // 2. Lead velocity (leads/day vs expected from monthly goal)
    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const pctMonth = dayOfMonth / daysInMonth;
    const monthLeads = await sbGet(`meta_leads_wa?select=id&created_at=gte.${isoDate(new Date(now.getFullYear(), now.getMonth(), 1))}`).then(r => r.length).catch(() => 0);
    let velScore = 12; // neutral
    if (goalLeads > 0) {
      const pctGoal = monthLeads / goalLeads;
      const onTrackRatio = pctGoal / pctMonth;
      velScore = Math.min(25, Math.max(0, Math.round(onTrackRatio * 20)));
    } else if (totLeads > 0) velScore = Math.min(25, totLeads * 3);

    // 3. Ad diversity (% of active ads that have leads in 7d)
    const activeIds = ads.map(a => a.id);
    const adsWithLeads = activeIds.filter(id => (agg[id]?.leads || 0) > 0).length;
    const divScore = activeIds.length > 0 ? Math.min(25, Math.round(adsWithLeads / activeIds.length * 25)) : 12;

    // 4. Spend pacing (is monthly spend on track?)
    let pacingScore = 12;
    if (goalSpend > 0) {
      const monthSpend = await sbGet(`meta_ad_metrics?entity_type=eq.ad&date_start=gte.${isoDate(new Date(now.getFullYear(), now.getMonth(), 1))}&select=spend`).then(rows => rows.reduce((s, r) => s + parseFloat(r.spend || 0), 0)).catch(() => 0);
      const pctSpend = monthSpend / goalSpend;
      const paceRatio = pctSpend / pctMonth;
      // On track = 1.0, slight over/under ok
      if (paceRatio >= 0.8 && paceRatio <= 1.2) pacingScore = 25;
      else if (paceRatio >= 0.6 && paceRatio <= 1.5) pacingScore = 18;
      else pacingScore = 8;
    } else pacingScore = 15;

    const score = Math.min(100, ctrScore + velScore + divScore + pacingScore);
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';

    return res.status(200).json({
      ok: true, score, grade,
      breakdown: { ctr: ctrScore, velocity: velScore, diversity: divScore, pacing: pacingScore },
      meta: { avgCtr: avgCtr.toFixed(2), totLeads, totSpend: Math.round(totSpend), activeAds: activeIds.length, adsWithLeads },
    });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
}

async function runUpdateLead(req, res) {
  try {
    const { id, calificado, estado, notas } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const updates = { updated_at: new Date().toISOString() };
    if (calificado !== undefined) updates.calificado = calificado;
    if (estado !== undefined) updates.estado = estado;
    if (notas !== undefined) updates.notas = notas;
    await sbReq('PATCH', `meta_leads_wa?id=eq.${id}`, updates);
    return res.status(200).json({ ok: true });
  } catch(err) { return res.status(200).json({ ok: false, error: err.message }); }
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
  if (action === 'budget_recs')       return runBudgetRecs(res);
  if (action === 'anomaly_check')     return runAnomalyCheck(res);
  if (action === 'monthly_goals')     return runMonthlyGoals(res);
  if (action === 'wow_metrics')       return runWoWMetrics(res);
  if (action === 'leaderboard')       return runLeaderboard(res);
  if (action === 'decay_check')       return runDecayCheck(res);
  if (action === 'adset_efficiency')  return runAdsetEfficiency(res);
  if (action === 'morning_brief')     return runMorningBrief(res);
  if (action === 'cpl_trend')         return runCplTrend(res);
  if (action === 'account_health')    return runAccountHealth(res);
  if (action === 'update_lead')       return runUpdateLead(req, res);
  return runSync(res);
}
