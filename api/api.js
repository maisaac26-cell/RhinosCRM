const https  = require('https');
const crypto = require('crypto');

// ── Config de Instagram desde Supabase (con caché por cold start) ──
const SB_URL_CONF = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY_CONF = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';
let _igConfigCache = null;

async function getIgConfig() {
  if (_igConfigCache) return _igConfigCache;
  try {
    const data = await new Promise((resolve) => {
      const req = https.request({
        hostname: new URL(SB_URL_CONF).hostname,
        path: '/rest/v1/rhinos_config?key=in.(ig_access_token,ig_account_id)',
        method: 'GET',
        headers: { 'apikey': SB_KEY_CONF, 'Authorization': 'Bearer ' + SB_KEY_CONF }
      }, (r) => {
        let raw = ''; r.on('data', c => raw += c);
        r.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve([]); } });
      });
      req.on('error', () => resolve([])); req.end();
    });
    if (Array.isArray(data) && data.length) {
      const cfg = {};
      data.forEach(r => { cfg[r.key] = r.value; });
      if (cfg.ig_access_token) { _igConfigCache = cfg; return cfg; }
    }
  } catch(e) {}
  // Fallback a env vars
  return { ig_access_token: process.env.IG_ACCESS_TOKEN, ig_account_id: process.env.IG_ACCOUNT_ID };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw.slice(0,200))); } });
    });
    req.on('error', reject); req.end();
  });
}

async function igFetch(path, method, body) {
  const cfg = await getIgConfig();
  const IG_TOKEN = cfg.ig_access_token;
  const baseUrl = `https://graph.facebook.com/v25.0/${path}${path.includes('?') ? '&' : '?'}access_token=${IG_TOKEN}`;

  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function anthropicFetch(messages, system) {
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system,
    messages
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          const text = d.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
          resolve(text);
        } catch(e) { reject(new Error(raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Google Analytics 4 — Service Account JWT Auth ────
let _gaTokenCache = null; // { token, exp }

async function getGAAccessToken() {
  if (_gaTokenCache && _gaTokenCache.exp > Date.now() / 1000 + 60) return _gaTokenCache.token;

  const clientEmail = process.env.GA_CLIENT_EMAIL;
  const privateKey  = (process.env.GA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) throw new Error('GA credentials no configuradas');

  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: clientEmail, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now };

  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const sign    = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(privateKey, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const tokenData = await new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
      let raw = ''; r.on('data', c => raw += c);
      r.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw)); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });

  if (!tokenData.access_token) throw new Error('GA Auth failed: ' + JSON.stringify(tokenData));
  _gaTokenCache = { token: tokenData.access_token, exp: now + (tokenData.expires_in || 3600) };
  return _gaTokenCache.token;
}

async function gaReport(propertyId, body) {
  const token = await getGAAccessToken();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'analyticsdata.googleapis.com',
      path: `/v1beta/properties/${propertyId}:runReport`,
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (r) => {
      let raw = ''; r.on('data', c => raw += c);
      r.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw.slice(0,300))); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Method not allowed' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); } }

  const igCfg = await getIgConfig();
  const IG_ID = igCfg.ig_account_id || process.env.IG_ACCOUNT_ID;
  const { action } = body;

  try {
    let result;

    if (action === 'convert_story_format') {
      // Descarga la imagen y la convierte a 9:16 con barras #0d1117 arriba/abajo
      const { image_url } = body;
      if (!image_url) throw new Error('Se requiere image_url');

      // Descargar imagen
      const imgBuffer = await new Promise((resolve, reject) => {
        const u = new URL(image_url);
        const lib = u.protocol === 'https:' ? https : require('http');
        const req = lib.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
          if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
            return lib.get(res.headers.location, (r2) => {
              const chunks = [];
              r2.on('data', c => chunks.push(c));
              r2.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject);
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
      });

      // Devolver como base64 para que el frontend lo dibuje en canvas
      result = { imageBase64: imgBuffer.toString('base64'), mime: 'image/png' };
    }

    else if (action === 'save_ig_config') {
      const { token } = body;
      if (!token) { return res.status(400).json({ error: 'Token requerido' }); }

      // 1. Intentar convertir a long-lived token usando credenciales guardadas
      let finalToken = token;
      let isLongLived = false;
      try {
        const cfg = await getIgConfig();
        const appId     = cfg.ig_app_id     || process.env.IG_APP_ID;
        const appSecret = cfg.ig_app_secret  || process.env.IG_APP_SECRET;
        if (appId && appSecret) {
          const exchangeUrl = `https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${encodeURIComponent(token)}`;
          const exchanged = await httpGet(exchangeUrl);
          if (exchanged.access_token && !exchanged.error) {
            finalToken = exchanged.access_token;
            isLongLived = true;
          }
        }
      } catch(e) { /* Si falla el exchange, seguimos con el token original */ }

      // 2. Validar token final contra Meta API
      let accountId, username, followers, expiresIn;
      try {
        const pages = await httpGet(`https://graph.facebook.com/v25.0/me/accounts?fields=name,instagram_business_account&access_token=${encodeURIComponent(finalToken)}`);
        if (pages.error) throw new Error(pages.error.message);
        accountId = pages.data?.[0]?.instagram_business_account?.id;
        if (!accountId) throw new Error('No hay cuenta de Instagram Business asociada');

        const profile = await httpGet(`https://graph.facebook.com/v25.0/${accountId}?fields=username,followers_count&access_token=${encodeURIComponent(finalToken)}`);
        if (profile.error) throw new Error(profile.error.message);
        username = profile.username;
        followers = profile.followers_count;

        // Verificar cuánto dura
        const debug = await httpGet(`https://graph.facebook.com/v25.0/debug_token?input_token=${encodeURIComponent(finalToken)}&access_token=${encodeURIComponent(finalToken)}`);
        expiresIn = debug.data?.expires_at ? Math.ceil((debug.data.expires_at - Date.now()/1000) / 86400) : null;
      } catch(e) {
        return res.status(200).json({ error: 'Token inválido: ' + e.message });
      }

      // 3. Guardar token final en Supabase
      const now = new Date().toISOString();
      const configs = [
        { key: 'ig_access_token', value: finalToken, updated_at: now },
        { key: 'ig_account_id',   value: accountId,  updated_at: now }
      ];
      const sbPayload = JSON.stringify(configs);
      await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: new URL(SB_URL_CONF).hostname, path: '/rest/v1/rhinos_config', method: 'POST',
          headers: { 'apikey': SB_KEY_CONF, 'Authorization': 'Bearer ' + SB_KEY_CONF, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sbPayload), 'Prefer': 'resolution=merge-duplicates,return=minimal' }
        }, (r) => { let raw = ''; r.on('data', c => raw += c); r.on('end', () => resolve()); });
        req2.on('error', reject); req2.write(sbPayload); req2.end();
      });

      _igConfigCache = null; // invalidar caché

      result = { ok: true, account_id: accountId, username, followers, updated_at: now, long_lived: isLongLived, days_valid: expiresIn };
    }

    else if (action === 'get_ig_config_status') {
      // Devuelve el estado actual del token (sin exponer el token completo)
      try {
        const data = await new Promise((resolve) => {
          const req2 = https.request({
            hostname: new URL(SB_URL_CONF).hostname,
            path: '/rest/v1/rhinos_config?key=in.(ig_access_token,ig_account_id)',
            method: 'GET',
            headers: { 'apikey': SB_KEY_CONF, 'Authorization': 'Bearer ' + SB_KEY_CONF }
          }, (r) => {
            let raw = ''; r.on('data', c => raw += c);
            r.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve([]); } });
          });
          req2.on('error', () => resolve([])); req2.end();
        });
        const cfg = {};
        (data || []).forEach(r => { cfg[r.key] = r; });
        const tokenRow = cfg.ig_access_token;
        if (!tokenRow) { result = { connected: false }; }
        else {
          const updatedAt = new Date(tokenRow.updated_at);
          const expiresAt = new Date(updatedAt.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 días
          const daysLeft = Math.ceil((expiresAt - new Date()) / (24 * 60 * 60 * 1000));
          result = {
            connected: true,
            account_id: cfg.ig_account_id?.value,
            token_preview: tokenRow.value.slice(0, 20) + '...',
            updated_at: tokenRow.updated_at,
            expires_at: expiresAt.toISOString(),
            days_left: daysLeft
          };
        }
      } catch(e) { result = { connected: false, error: e.message }; }
    }

    else if (action === 'ga_report') {
      const propertyId = process.env.GA_PROPERTY_ID;
      if (!propertyId) { result = { error: 'GA_PROPERTY_ID no configurado' }; return res.status(200).json(result); }

      const { range = '30daysAgo' } = body;
      const dateRange = [{ startDate: range, endDate: 'today' }];

      try {
        const [overview, pages, sources, devices, countries] = await Promise.all([

          // 1. Métricas generales
          gaReport(propertyId, {
            dateRanges: [
              { startDate: 'today',     endDate: 'today' },
              { startDate: '7daysAgo',  endDate: 'today' },
              { startDate: '30daysAgo', endDate: 'today' }
            ],
            metrics: [
              { name: 'activeUsers' }, { name: 'sessions' },
              { name: 'screenPageViews' }, { name: 'bounceRate' },
              { name: 'averageSessionDuration' }, { name: 'newUsers' }
            ]
          }),

          // 2. Top páginas
          gaReport(propertyId, {
            dateRanges: dateRange,
            dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
            metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'averageSessionDuration' }],
            orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
            limit: 8
          }),

          // 3. Fuentes de tráfico
          gaReport(propertyId, {
            dateRanges: dateRange,
            dimensions: [{ name: 'sessionDefaultChannelGroup' }],
            metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
            orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
            limit: 8
          }),

          // 4. Dispositivos
          gaReport(propertyId, {
            dateRanges: dateRange,
            dimensions: [{ name: 'deviceCategory' }],
            metrics: [{ name: 'sessions' }, { name: 'activeUsers' }]
          }),

          // 5. Países
          gaReport(propertyId, {
            dateRanges: dateRange,
            dimensions: [{ name: 'country' }],
            metrics: [{ name: 'activeUsers' }],
            orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
            limit: 5
          })
        ]);

        // Procesar overview por dateRange
        const parseMetrics = (row) => {
          const m = {};
          overview.metricHeaders.forEach((h, i) => { m[h.name] = +row.metricValues[i].value; });
          return m;
        };
        const ovRows = overview.rows || [];
        const metrics = {
          today:   ovRows[0] ? parseMetrics(ovRows[0]) : {},
          week7:   ovRows[1] ? parseMetrics(ovRows[1]) : {},
          month30: ovRows[2] ? parseMetrics(ovRows[2]) : {}
        };

        // Parsear tabla genérica
        const parseTable = (report) => (report.rows || []).map(row => {
          const obj = {};
          (report.dimensionHeaders || []).forEach((h, i) => { obj[h.name] = row.dimensionValues[i].value; });
          (report.metricHeaders || []).forEach((h, i) => { obj[h.name] = +row.metricValues[i].value; });
          return obj;
        });

        result = {
          metrics,
          pages:     parseTable(pages),
          sources:   parseTable(sources),
          devices:   parseTable(devices),
          countries: parseTable(countries),
          range
        };
      } catch(e) {
        result = { error: 'GA API error: ' + e.message };
      }
    }

    else if (action === 'get_tipo_cambio') {
      try {
        const data = await httpGet('https://api.bluelytics.com.ar/v2/latest');
        result = {
          oficial_compra: data.oficial?.value_buy || null,
          oficial_venta: data.oficial?.value_sell || null,
          blue_compra: data.blue?.value_buy || null,
          blue_venta: data.blue?.value_sell || null,
          fecha: data.last_update || new Date().toISOString(),
          fuente: 'Banco Nación Argentina'
        };
      } catch(e) {
        result = { error: 'No se pudo obtener cotización: ' + e.message };
      }
    }

    else if (action === 'supabase_upsert_clients') {
      // Guarda/actualiza clientes en Supabase (tabla rhinos_clients)
      const { clients } = body;
      if (!clients || !clients.length) { result = { ok: true, count: 0 }; return res.status(200).json(result); }
      const SB_URL_C = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
      const SB_KEY_C = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';
      const payload = JSON.stringify(clients);
      const resp = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: new URL(SB_URL_C).hostname,
          path: '/rest/v1/rhinos_clients',
          method: 'POST',
          headers: {
            'apikey': SB_KEY_C, 'Authorization': 'Bearer ' + SB_KEY_C,
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          }
        }, (r) => {
          let raw = ''; r.on('data', c => raw += c);
          r.on('end', () => resolve({ status: r.statusCode, body: raw }));
        });
        req2.on('error', reject); req2.write(payload); req2.end();
      });
      result = { ok: resp.status < 300, status: resp.status, count: clients.length };
    }

    else if (action === 'supabase_upsert') {
      // Upsert genérico — acepta cualquier tabla del proyecto
      const { table, rows } = body;
      const ALLOWED = ['rhinos_recurring_txs','rhinos_pres_tiers','rhinos_pres_history',
        'rhinos_prospect_emails','rhinos_email_templates','rhinos_balance',
        'rhinos_clients','rhinos_cobros','rhinos_tc_historico','rhinos_partners'];
      if (!table || !ALLOWED.includes(table)) { return res.status(400).json({ error: 'Tabla no permitida: ' + table }); }
      if (!rows?.length) { result = { ok: true, count: 0 }; return res.status(200).json(result); }
      const SB_URL_G = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
      const SB_KEY_G = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';
      const payload = JSON.stringify(rows);
      const resp = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: new URL(SB_URL_G).hostname,
          path: `/rest/v1/${table}`,
          method: 'POST',
          headers: {
            'apikey': SB_KEY_G, 'Authorization': 'Bearer ' + SB_KEY_G,
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          }
        }, (r) => {
          let raw = ''; r.on('data', c => raw += c);
          r.on('end', () => resolve({ status: r.statusCode, body: raw }));
        });
        req2.on('error', reject); req2.write(payload); req2.end();
      });
      result = { ok: resp.status < 300, status: resp.status };
    }

    else if (action === 'supabase_upsert_cobros') {
      // Guarda/actualiza cobros en Supabase (tabla rhinos_cobros)
      const { cobros } = body;
      if (!cobros || !cobros.length) { result = { ok: true, count: 0 }; return res.status(200).json(result); }
      const SB_URL_C = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
      const SB_KEY_C = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';
      const payload = JSON.stringify(cobros);
      const resp = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: new URL(SB_URL_C).hostname,
          path: '/rest/v1/rhinos_cobros',
          method: 'POST',
          headers: {
            'apikey': SB_KEY_C, 'Authorization': 'Bearer ' + SB_KEY_C,
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          }
        }, (r) => {
          let raw = ''; r.on('data', c => raw += c);
          r.on('end', () => resolve({ status: r.statusCode, body: raw }));
        });
        req2.on('error', reject); req2.write(payload); req2.end();
      });
      result = { ok: resp.status < 300, status: resp.status, count: cobros.length };
    }

    else if (action === 'supabase_proxy') {
      const { endpoint, method: m = 'GET', body: b } = body;
      const SB_URL_P = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
      const SB_KEY_P = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';
      const payload = b ? JSON.stringify(b) : undefined;
      const hdrs = {
        'apikey': SB_KEY_P, 'Authorization': 'Bearer ' + SB_KEY_P, 'Content-Type': 'application/json',
        'Prefer': m === 'POST' || m === 'PATCH' ? 'return=representation' : m === 'DELETE' ? 'return=minimal' : ''
      };
      if (payload) hdrs['Content-Length'] = Buffer.byteLength(payload);
      const u = new URL(`${SB_URL_P}/rest/v1/${endpoint}`);
      const sbRes = await new Promise((resolve, reject) => {
        const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: m, headers: hdrs }, (res) => {
          let raw = ''; res.on('data', c => raw += c);
          res.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch(e) { resolve(raw); } });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
      result = sbRes;
    }

    else if (action === 'upload_image_public') {
      // Sube una imagen base64 a imgbb y devuelve una URL pública para Instagram
      const { imageBase64, mime = 'image/png' } = body;
      const IMGBB_KEY = process.env.IMGBB_API_KEY || '4823ec0cd2cbdbcd056011baf20c1830';
      if (!IMGBB_KEY) throw new Error('IMGBB_API_KEY no configurada');

      const formData = `key=${IMGBB_KEY}&image=${encodeURIComponent(imageBase64)}`;
      const uploadData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.imgbb.com',
          path: '/1/upload',
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formData) }
        }, (res) => {
          let raw = ''; res.on('data', c => raw += c);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw.slice(0,200))); } });
        });
        req.on('error', reject); req.write(formData); req.end();
      });

      if (!uploadData.success) throw new Error('imgbb error: ' + JSON.stringify(uploadData.error || uploadData));
      result = { url: uploadData.data.url, display_url: uploadData.data.display_url };
    }

    else if (action === 'ig_create_container') {
      const { image_url, caption, format = 'feed' } = body;
      if (!image_url) throw new Error('Se requiere image_url');
      if (image_url.startsWith('blob:') || image_url.startsWith('data:')) {
        throw new Error('URL local — necesita subirse a un host público primero');
      }
      const isStory = format === 'story';
      const containerPath = isStory
        ? `${IG_ID}/media?image_url=${encodeURIComponent(image_url)}&media_type=STORIES`
        : `${IG_ID}/media?image_url=${encodeURIComponent(image_url)}&caption=${encodeURIComponent(caption || '')}`;
      const container = await igFetch(containerPath, 'POST');
      if (!container.id) throw new Error('Error creando container: ' + JSON.stringify(container));
      result = { creation_id: container.id };
    }

    else if (action === 'ig_check_status') {
      // Paso 2: El frontend llama esto cada 3s hasta que sea FINISHED
      const { creation_id } = body;
      const check = await igFetch(`${creation_id}?fields=status_code`);
      result = { status: check.status_code || 'IN_PROGRESS', error: check.error };
    }

    else if (action === 'ig_publish_container') {
      // Paso 3: Publicar el container ya procesado
      const { creation_id } = body;
      const published = await igFetch(`${IG_ID}/media_publish?creation_id=${creation_id}`, 'POST');
      if (!published.id) throw new Error('Error publicando: ' + JSON.stringify(published));
      result = { id: published.id, success: true };
    }

    else if (action === 'ig_publish') {
      // Mantener compatibilidad con código anterior
      const { image_url, caption } = body;
      if (!image_url) throw new Error('Se requiere image_url');
      const containerPath = `${IG_ID}/media?image_url=${encodeURIComponent(image_url)}&caption=${encodeURIComponent(caption || '')}`;
      const container = await igFetch(containerPath, 'POST');
      if (!container.id) throw new Error('Error creando container: ' + JSON.stringify(container));
      result = { creation_id: container.id };
    }

    else if (action === 'get_metrics') {
      const [profile, insights] = await Promise.all([
        igFetch(`${IG_ID}?fields=username,followers_count,media_count,profile_picture_url,biography,website`),
        igFetch(`${IG_ID}/insights?metric=impressions,reach,profile_views,follower_count&period=day&since=${Math.floor(Date.now()/1000) - 604800}&until=${Math.floor(Date.now()/1000)}`)
      ]);
      result = { profile, insights };
    }

    else if (action === 'get_media') {
      const media = await igFetch(`${IG_ID}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=20`);
      result = media;
    }

    else if (action === 'get_comments') {
      const { media_id } = body;
      const comments = await igFetch(`${media_id}/comments?fields=id,text,username,timestamp,replies{id,text,username,timestamp}&limit=50`);
      result = comments;
    }

    else if (action === 'reply_comment') {
      const { comment_id, message } = body;
      const reply = await igFetch(`${comment_id}/replies`, 'POST', { message });
      result = reply;
    }

    else if (action === 'get_conversations') {
      const convs = await igFetch(`${IG_ID}/conversations?platform=instagram&fields=id,updated_time,participants,messages{id,message,from,created_time}&limit=20`);
      result = convs;
    }

    else if (action === 'send_message') {
      const { recipient_id, message } = body;
      const sent = await igFetch(`${IG_ID}/messages`, 'POST', {
        recipient: { id: recipient_id },
        message: { text: message }
      });
      result = sent;
    }

    else if (action === 'ai_reply') {
      const { context, type } = body;
      const SYSTEM = `Sos el community manager de RhinosApp, un CRM para distribuidores de alimentos en Argentina.
Marca: profesional, directa, disruptiva. Nunca corporativa.
Tu objetivo: convertir interacciones en leads (demo por WhatsApp o Calendly).
WhatsApp: +54 9 11 6822-3306 | Demo: calendly.com/comercial-rhinosapp
Respondé en español rioplatense, máximo 3 líneas para comentarios, más extenso para DMs.
Usá 🦏 solo cuando sea natural. No uses signos de exclamación en exceso.`;
      const prompt = type === 'dm' 
        ? `Generá una respuesta para este DM recibido en Instagram de RhinosApp:\n\n"${context}"\n\nObjetivo: llevar al lead a agendar una demo.`
        : `Generá una respuesta para este comentario en Instagram de RhinosApp:\n\n"${context}"\n\nSea breve, cercana y con CTA si aplica.`;
      const reply = await anthropicFetch([{ role: 'user', content: prompt }], SYSTEM);
      result = { reply };
    }

    else if (action === 'ai_agent') {
      const { messages, system } = body;
      const reply = await anthropicFetch(messages, system);
      result = { reply };
    }

    else if (action === 'generate_content') {
      const { modulo, angulo, formato, tono, cta } = body;
      const SYSTEM = `Sos el agente de marketing de RhinosApp — CRM/ERP para pymes y distribuidoras en Argentina.

PRODUCTO REAL (rhinosapp.vercel.app):
- Tagline: "Controlá pedidos, stock y cobranzas con inteligencia artificial"
- Propuesta: Reemplaza Excel y procesos manuales por una sola plataforma con visibilidad total en tiempo real
- Plan único con usuarios ilimitados + app móvil para vendedores + IA + soporte WhatsApp
- Bonus: migración gratuita desde Excel/papel + capacitación del equipo incluida
- AFIP/ARCA integrado (facturación electrónica automática)

MÓDULOS REALES:
1. Inteligencia comercial y reportes automáticos
2. Panel principal con indicadores del negocio
3. Clientes y cuentas corrientes
4. Proveedores
5. Productos y stock en tiempo real
6. Ventas y pedidos
7. Cobranzas y cuentas por cobrar
8. Compras y cuentas por pagar
9. ARCA — Integración automática con AFIP

DOLORES REALES del cliente (lo que dicen hoy):
- "Tengo el stock en Excel y siempre está desactualizado"
- "No sé cuánto me deben mis clientes hasta que llamo uno por uno"
- "Mis vendedores anotan los pedidos en papel y se pierden cosas"
- "La facturación me lleva horas y siempre hay errores"
- "No tengo reportes — todo está en mi cabeza"

CLIENTE: dueño de distribuidora (quesos, fiambres, bebidas, alimentos), 35-55 años, Argentina, acostumbrado a Excel/WhatsApp, no tech-savvy, valora el orden y el control.

IDENTIDAD: fondo #0d1117, acento #00e5cc, verde CTA #22c55e. Logo: 🦏 rinoceronte robótico. Tono: profesional, directo, disruptivo. Nunca corporativo.

CONTACTO: WhatsApp +54 9 11 6822-3306 | calendly.com/comercial-rhinosapp | comercial@rhinosapp.com`;

      const prompt = `Generá contenido para Instagram de RhinosApp:
MÓDULO/TEMA: ${modulo}
ÁNGULO ESPECÍFICO: ${angulo || 'libre — elegí el más impactante'}
FORMATO: ${formato}
TONO: ${tono}
CTA: ${cta}

Respondé SOLO con un JSON válido con esta estructura exacta (sin markdown, sin texto antes ni después):
{
  "caption": "El caption completo listo para pegar en Instagram. Con emojis estratégicos, saltos de línea reales con \\n, español rioplatense, incluye el CTA al final. SIN hashtags aquí.",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3 ... (15-20 hashtags en una sola línea)",
  "ideas_visuales": "2-3 ideas concretas para el diseño con colores #0d1117 y #00e5cc",
  "timing": "Mejor día y hora para publicar este contenido"
}`;
      const raw = await anthropicFetch([{ role: 'user', content: prompt }], SYSTEM);
      // Parsear JSON, tolerar markdown fences
      let parsed;
      try {
        const clean = raw.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch(e) {
        parsed = { caption: raw, hashtags: '', ideas_visuales: '', timing: '' };
      }
      result = { ...parsed, raw };
    }

    else if (action === 'prospect_search') {
      const { query, location, provincia, next_page_token } = body;
      const PLACES_KEY = process.env.GOOGLE_PLACES_KEY;
      
      // Build search query
      const searchQuery = encodeURIComponent(`${query || 'distribuidora de alimentos'} ${location || provincia || 'Argentina'}`);
      
      let url;
      if (next_page_token) {
        url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${next_page_token}&key=${PLACES_KEY}`;
      } else {
        url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${searchQuery}&type=establishment&language=es&region=ar&key=${PLACES_KEY}`;
      }
      
      const placesData = await httpGet(url);
      
      if (placesData.status !== 'OK' && placesData.status !== 'ZERO_RESULTS') {
        throw new Error(`Google Places: ${placesData.status} — ${placesData.error_message || 'Sin billing activado o API key inválida'}`);
      }

      if (placesData.status === 'ZERO_RESULTS') {
        result = { places: [], total: 0, next_page_token: null, status: 'ZERO_RESULTS' };
      } else {
        const places = placesData.results || [];
        const detailed = await Promise.all(places.slice(0, 15).map(async (place) => {
          try {
            const det = await httpGet(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,international_phone_number,website,formatted_address,rating,user_ratings_total,business_status&language=es&key=${PLACES_KEY}`);
            const d = det.result || {};
            return {
              id: place.place_id, name: place.name,
              address: d.formatted_address || place.formatted_address,
              phone: d.formatted_phone_number || d.international_phone_number || null,
              website: d.website || null,
              rating: place.rating || null, reviews: place.user_ratings_total || 0,
              has_phone: !!(d.formatted_phone_number || d.international_phone_number),
              has_website: !!d.website,
            };
          } catch(e) {
            return {
              id: place.place_id, name: place.name,
              address: place.formatted_address, phone: null, website: null,
              rating: place.rating, reviews: place.user_ratings_total || 0,
              has_phone: false, has_website: false
            };
          }
        }));
        result = {
          places: detailed, total: places.length,
          next_page_token: placesData.next_page_token || null, status: 'OK'
        };
      }
    }

    else if (action === 'find_prospect_email') {
      const { website } = body;
      if (!website) { result = { emails: [] }; }
      else {
        const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const skipDomains = /\.(png|jpg|jpeg|gif|svg|webp|css|js|pdf)$/i;
        const skipWords = /noreply|no-reply|donotreply|example\.com|sentry\.|wix\.|wordpress\.|schema\.|googleapis/i;

        async function fetchPage(pageUrl) {
          return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(''), 6000);
            try {
              const u = new URL(pageUrl.startsWith('http') ? pageUrl : 'https://' + pageUrl);
              const isHttps = u.protocol === 'https:';
              const lib = isHttps ? https : require('http');
              const req = lib.request({
                hostname: u.hostname, path: u.pathname || '/', method: 'GET',
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)', 'Accept': 'text/html' },
                timeout: 5000
              }, (res) => {
                // Follow redirects
                if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
                  clearTimeout(timeout);
                  const loc = res.headers.location.startsWith('http') ? res.headers.location : `${u.origin}${res.headers.location}`;
                  fetchPage(loc).then(resolve);
                  return;
                }
                let html = '';
                res.on('data', c => { html += c; if (html.length > 300000) res.destroy(); });
                res.on('end', () => { clearTimeout(timeout); resolve(html); });
                res.on('error', () => { clearTimeout(timeout); resolve(''); });
              });
              req.on('error', () => { clearTimeout(timeout); resolve(''); });
              req.on('timeout', () => { req.destroy(); clearTimeout(timeout); resolve(''); });
              req.end();
            } catch(e) { clearTimeout(timeout); resolve(''); }
          });
        }

        function extractEmails(html) {
          return [...new Set((html.match(emailRegex) || [])
            .filter(e => !skipWords.test(e) && !skipDomains.test(e) && e.includes('.') && e.length < 80)
          )];
        }

        let emails = [];
        const base = website.startsWith('http') ? new URL(website).origin : 'https://' + website;

        // Buscar en página principal y /contacto en paralelo
        const [mainHtml, contactHtml] = await Promise.all([
          fetchPage(base),
          fetchPage(base + '/contacto').catch(() => '')
        ]);

        emails = [...new Set([...extractEmails(mainHtml), ...extractEmails(contactHtml)])];

        // Si no encontró nada, probar /contact
        if (!emails.length) {
          const contactEnHtml = await fetchPage(base + '/contact').catch(() => '');
          emails = extractEmails(contactEnHtml);
        }

        result = { emails: emails.slice(0, 5) };
      }
    }

    else if (action === 'prospect_enrich') {
      const { name, website, address } = body;
      const SYSTEM = `Sos un asistente de prospección comercial para RhinosApp, un CRM para distribuidoras de alimentos en Argentina.`;
      const prompt = `Dado este prospecto:
Nombre: ${name}
Dirección: ${address || 'No disponible'}
Website: ${website || 'No disponible'}

Generá un análisis breve de prospección:
1. POTENCIAL (alto/medio/bajo) y por qué
2. CÓMO CONTACTAR (mejor canal y momento)
3. PAIN POINT probable basado en el tipo de negocio
4. MENSAJE DE APERTURA sugerido para WhatsApp (máximo 3 líneas)

Sé concreto y accionable. Español rioplatense.`;
      const reply = await anthropicFetch([{ role: 'user', content: prompt }], SYSTEM);
      result = { reply };
    }

    else if (action === 'generate_image_prompt') {
      const { modulo, angulo, formato, tono } = body;

      const SYS = `Sos el director creativo de RhinosApp — CRM/ERP para distribuidoras de alimentos en Argentina.
Creás prompts para imágenes de Instagram @rhinosapp que repliquen EXACTAMENTE el estilo visual del feed real.

ESTILO VISUAL REAL DEL FEED @rhinosapp (analizá cada elemento):

FONDO: Fotografía industrial realista — depósitos, centros de distribución, galpones con estantes, trabajadores con chalecos reflectantes, camiones de carga, cajas apiladas. Iluminación dramática industrial con toques de luz azul-cyan. NO renders puros — fotografía híbrida con overlay digital.

OVERLAY TECH: Sobre la foto real se aplican capas digitales:
• Panel semitransparente oscuro (#0d1117 con 75-85% opacidad) que cubre parte de la imagen
• Bordes/marcos con líneas cyan (#00e5cc) brillantes
• Elementos de circuito, hexágonos y partículas de datos flotando
• Iconos digitales, checkmarks, indicadores HUD sutiles

EL LOGO — SIEMPRE PRESENTE EN UNA ESQUINA O CENTRO SUPERIOR:
• Cabeza de rinoceronte mecánico con armadura hexagonal, vista 3/4 perfil derecho
• Ojo único cibernético con glow cyan
• Cuerno cristalino luminoso con neón cyan
• Marco hexagonal con trazos de circuito y nodos en vértices
• Texto "RHINOS" con la O como engranaje cyan debajo del logo
• Se coloca: esquina superior izquierda (pequeño) O centro superior (mediano) según composición

COMPOSICIÓN:
• Zona superior: logo del rhino + espacio oscuro para título grande
• Zona central: elemento visual del tema (cajas, datos, trabajadores, tablero)
• Zona inferior: panel oscuro con íconos/checkmarks + CTA
• La imagen SIEMPRE tiene áreas oscuras para que el texto sea legible encima
• Formato cuadrado 1:1 para feed, o 4:5

PALETA EXACTA:
• Base: foto industrial real con filtro oscuro azulado
• #0d1117 para paneles y overlays
• #00e5cc para bordes, íconos, glow, checkmarks positivos
• #ef4444 (rojo) para X o problemas/errores
• Blanco brillante para texto principal (se superpone encima)

TONO NARRATIVO DE LAS IMÁGENES:
Las mejores imágenes del feed muestran el CONTRASTE entre:
- Lado problema (desorden, error, X roja): trabajador confundido, papeles dispersos, cajas caóticas
- Lado solución (orden, sistema, checkmark cyan): tablero digital, flujo organizado, datos en control`;

      const { caption } = body;

      const pr = `Creá un prompt en inglés para una imagen de Instagram de @rhinosapp.

${caption ? `CAPTION QUE VA A ACOMPAÑAR ESTA IMAGEN:
"${caption.slice(0, 600)}"

EXTRAE del caption:
1. El DOLOR principal que menciona (ej: "ventas que se escapan", "cobranzas desordenadas")
2. La SOLUCIÓN que propone (ej: "control total", "sistema", "orden")
3. El ESCENARIO FÍSICO más apropiado (depósito, camión, oficina de distribuidora, calle con vendedores)

` : ''}MÓDULO/TEMA: ${modulo}
ÁNGULO: ${angulo || 'contraste problema vs solución'}
FORMATO: ${formato}
TONO: ${tono}

CONSTRUÍ el prompt siguiendo EXACTAMENTE esta estructura:

APERTURA (fondo fotorrealista):
"Photorealistic hybrid image, industrial Argentine food distribution warehouse interior, [escenario específico del tema], dramatic industrial lighting with cyan (#00e5cc) accent lights, dark blue atmospheric overlay,"

LOGO (siempre presente):
"[corner position] small-to-medium cyberpunk mechanical armored rhinoceros logo badge: hexagonal metal plated rhino head 3/4 right profile, glowing cyan cybernetic eye, crystal luminous horn with cyan neon, hexagonal frame with circuit traces and glowing vertex nodes, 'RHINOS' text with gear-O below,"

ELEMENTOS DEL TEMA (conectado al caption):
"[elementos visuales que representan el dolor del caption en un lado] transforming into [elementos que representan la solución, con iconos cyan y checkmarks],"

OVERLAY DIGITAL:
"semi-transparent dark panel overlay (#0d1117 85% opacity) with cyan bordered sections, floating holographic data indicators, circuit board edge accents, HUD-style frame elements,"

CIERRE TÉCNICO:
"high contrast dark areas for text overlay, professional B2B marketing composition, no text no letters no words no numbers, Instagram square format, photorealistic quality"

Máximo 180 palabras. Respondé SOLO el prompt en inglés, listo para usar.`;
      const imagePromptText = await anthropicFetch([{ role: 'user', content: pr }], SYS);
      result = { prompt: imagePromptText };
    }

    else if (action === 'extract_image_text') {
      const { caption } = body;
      const SYSTEM = `Sos especialista en copywriting visual para RhinosApp — CRM para distribuidoras de alimentos en Argentina.
Creás frases cortas e impactantes para superponer sobre imágenes de Instagram.
Estilo: directo al dolor o beneficio, español rioplatense, máximo 5-6 palabras, TODO EN MAYÚSCULAS.
Inspiración del feed real: "¿SABÉS CUÁNTO TE DEBEN?", "SIN CONTROL, DEPENDÉS DE LA SUERTE", "TU COMPETENCIA YA SE ORDENÓ", "DEJÁ DE IMPROVISAR.", "¿CUÁNTAS VENTAS PERDISTE HOY?"`;
      const prompt = `Del siguiente caption de Instagram de RhinosApp, generá 4 opciones de frases diferentes para superponer sobre la imagen.

CAPTION:
"${caption.slice(0, 800)}"

Cada opción debe tener un enfoque diferente:
- Opción 1: pregunta que golpea el dolor del distribuidor
- Opción 2: afirmación de impacto sobre el problema
- Opción 3: frase de poder/solución (lo que logra con RhinosApp)
- Opción 4: contraste antes/después o comparación

Respondé SOLO con JSON válido, sin markdown:
{
  "opciones": [
    { "titular": "FRASE OPCIÓN 1 EN MAYÚSCULAS", "subtitulo": "línea corta de apoyo o null" },
    { "titular": "FRASE OPCIÓN 2 EN MAYÚSCULAS", "subtitulo": "línea corta de apoyo o null" },
    { "titular": "FRASE OPCIÓN 3 EN MAYÚSCULAS", "subtitulo": "línea corta de apoyo o null" },
    { "titular": "FRASE OPCIÓN 4 EN MAYÚSCULAS", "subtitulo": "línea corta de apoyo o null" }
  ],
  "cta": "rhinosapp.vercel.app"
}`;
      const raw = await anthropicFetch([{ role: 'user', content: prompt }], SYSTEM);
      try {
        const clean = raw.replace(/```json|```/g, '').trim();
        result = JSON.parse(clean);
      } catch(e) {
        result = {
          opciones: [
            { titular: 'CONTROLÁ TU NEGOCIO', subtitulo: 'Con RhinosApp' },
            { titular: '¿CUÁNTAS VENTAS PERDISTE?', subtitulo: null },
            { titular: 'SIN SISTEMA, SIN CONTROL', subtitulo: 'Ordenate con Rhinos' },
            { titular: 'TU COMPETENCIA YA SE ORDENÓ', subtitulo: null }
          ],
          cta: 'rhinosapp.vercel.app'
        };
      }
    }

    else if (action === 'generate_image_gemini') {
      const { prompt } = body;
      const GEMINI_KEY = process.env.GEMINI_API_KEY;

      // Modelos disponibles en plan gratuito (usan generateContent)
      const modelAliases = {
        'imagen-3.0-generate-002':        'gemini-2.5-flash-image',
        'imagen-3.0-fast-generate-001':   'gemini-3.1-flash-image-preview',
        'gemini-fast':                    'gemini-3.1-flash-image-preview',
        'gemini-pro':                     'gemini-3-pro-image-preview'
      };
      const geminiModel = modelAliases[body.gemini_model] || body.gemini_model || 'gemini-2.5-flash-image';

      const payload = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      });

      const imgData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_KEY}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
          let raw = ''; res.on('data', c => raw += c);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw.slice(0,300))); } });
        });
        req.on('error', reject); req.write(payload); req.end();
      });

      if (imgData.error) throw new Error('Gemini: ' + (imgData.error.message || JSON.stringify(imgData.error)));

      const parts = imgData.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (!imgPart) throw new Error('Gemini no generó imagen. Modelo: ' + geminiModel);

      result = { imageBase64: imgPart.inlineData.data, mime: imgPart.inlineData.mimeType, isBase64: true };
    }

    else if (action === 'generate_image') {
      const { prompt, size = 'square', quality = 'hd', variations = 1 } = body;
      const OPENAI_KEY = process.env.OPENAI_API_KEY;
      if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY no configurada en Vercel → Settings → Environment Variables');

      async function openAIImage(model, imgSize, imgQuality) {
        const payloadObj = { model, prompt, n: 1, size: imgSize };
        if (model === 'dall-e-3') { payloadObj.quality = imgQuality; }
        const payload = JSON.stringify(payloadObj);
        return new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'api.openai.com', path: '/v1/images/generations', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Length': Buffer.byteLength(payload) }
          }, (res) => {
            let raw = ''; res.on('data', c => raw += c);
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw.slice(0,200))); } });
          });
          req.on('error', reject); req.write(payload); req.end();
        });
      }

      // DALL-E 3 soporta portrait/landscape, DALL-E 2 solo 1024x1024
      const sizeMapD3 = { square:'1024x1024', portrait:'1024x1792', landscape:'1792x1024' };
      const count = Math.min(Math.max(1, +variations), 3);

      // Intentar DALL-E 3 primero, caer a DALL-E 2 si no está disponible
      let model = 'dall-e-3', finalSize = sizeMapD3[size] || '1024x1024';
      const testR = await openAIImage(model, finalSize, quality);
      if (testR.error?.message?.includes('does not exist') || testR.error?.message?.includes('deprecated')) {
        model = 'dall-e-2'; finalSize = '1024x1024'; // dall-e-2 solo soporta cuadrado
      } else if (testR.error) {
        throw new Error('OpenAI: ' + testR.error.message);
      }

      // Si ya tenemos resultado del test, usarlo. Si necesitamos más variaciones, pedir el resto
      const firstUrl = testR.data?.[0]?.url;
      let urls = firstUrl ? [firstUrl] : [];

      if (firstUrl && count > 1) {
        const extra = await Promise.all(
          Array.from({ length: count - 1 }, () => openAIImage(model, finalSize, quality))
        );
        for (const r of extra) {
          if (r.error) break; // ignorar errores en variaciones adicionales
          if (r.data?.[0]?.url) urls.push(r.data[0].url);
        }
      } else if (!firstUrl && model === 'dall-e-2') {
        // Reintentar con dall-e-2
        const r2 = await openAIImage('dall-e-2', '1024x1024', quality);
        if (r2.error) throw new Error('OpenAI: ' + r2.error.message);
        if (r2.data?.[0]?.url) urls = [r2.data[0].url];
      }

      if (!urls.length) throw new Error('No se pudo generar la imagen. Verificá el crédito en platform.openai.com/billing');
      result = { urls, url: urls[0], model_used: model };
    }

    else if (action === 'gmail_get_client_id') {
      result = { client_id: process.env.GMAIL_CLIENT_ID };
    }

    else if (action === 'gmail_exchange_code') {
      const { code } = body;
      const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
      const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
      const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI;
      const payload = new URLSearchParams({
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
      }).toString();
      const tokenData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
          let raw = ''; res.on('data', c => raw += c);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw)); } });
        });
        req.on('error', reject); req.write(payload); req.end();
      });
      result = tokenData;
    }

    else if (action === 'gmail_refresh') {
      const { refresh_token } = body;
      const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
      const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
      const payload = new URLSearchParams({
        refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token'
      }).toString();
      const tokenData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
          let raw = ''; res.on('data', c => raw += c);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw)); } });
        });
        req.on('error', reject); req.write(payload); req.end();
      });
      result = tokenData;
    }

    else if (action === 'gmail_list') {
      const { access_token, query, pageToken } = body;
      let path = `/gmail/v1/users/me/messages?maxResults=20&q=${encodeURIComponent(query || 'in:inbox')}`;
      if (pageToken) path += `&pageToken=${pageToken}`;
      const listData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'gmail.googleapis.com', path, method: 'GET',
          headers: { 'Authorization': 'Bearer ' + access_token }
        }, (res) => {
          let raw = ''; res.on('data', c => raw += c);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw)); } });
        });
        req.on('error', reject); req.end();
      });
      const messages = listData.messages || [];
      const detailed = await Promise.all(messages.slice(0, 15).map(m =>
        new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'gmail.googleapis.com',
            path: `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`,
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + access_token }
          }, (res) => {
            let raw = ''; res.on('data', c => raw += c);
            res.on('end', () => {
              try {
                const d = JSON.parse(raw);
                const headers = {};
                (d.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
                resolve({
                  id: d.id, threadId: d.threadId,
                  from: headers['From'] || '', subject: headers['Subject'] || '(Sin asunto)',
                  date: headers['Date'] || '', to: headers['To'] || '',
                  snippet: d.snippet || '', labelIds: d.labelIds || [],
                  unread: (d.labelIds || []).includes('UNREAD')
                });
              } catch(e) { resolve({ id: m.id, subject: '—', snippet: '' }); }
            });
          });
          req.on('error', reject); req.end();
        })
      ));
      result = { messages: detailed, nextPageToken: listData.nextPageToken };
    }

    else if (action === 'gmail_get') {
      const { access_token, message_id } = body;
      const msgData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'gmail.googleapis.com',
          path: `/gmail/v1/users/me/messages/${message_id}?format=full`,
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + access_token }
        }, (res) => {
          let raw = ''; res.on('data', c => raw += c);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw)); } });
        });
        req.on('error', reject); req.end();
      });
      const headers = {};
      (msgData.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
      let body_text = '';
      function extractBody(part) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          body_text = Buffer.from(part.body.data, 'base64').toString('utf-8');
        } else if (part.parts) { part.parts.forEach(extractBody); }
      }
      extractBody(msgData.payload || {});
      result = {
        id: msgData.id, threadId: msgData.threadId,
        from: headers['From'] || '', to: headers['To'] || '',
        subject: headers['Subject'] || '', date: headers['Date'] || '',
        body: body_text || msgData.snippet || ''
      };
    }

    else if (action === 'gmail_send') {
      const { access_token, to, subject, body: emailBody, thread_id, in_reply_to, references } = body;

      // Obtener email del usuario para el header From (necesario para guardar en Enviados)
      let senderEmail = '';
      try {
        const profile = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/profile', method: 'GET',
            headers: { 'Authorization': 'Bearer ' + access_token }
          }, (res) => {
            let raw = ''; res.on('data', c => raw += c);
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
          });
          req.on('error', () => resolve({})); req.end();
        });
        senderEmail = profile.emailAddress || '';
      } catch(e) {}

      const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject || '').toString('base64') + '?=';
      let rawEmail = `MIME-Version: 1.0\r\n`;
      if (senderEmail) rawEmail += `From: ${senderEmail}\r\n`;
      rawEmail += `To: ${to}\r\nSubject: ${encodedSubject}\r\nContent-Type: text/plain; charset=utf-8\r\n`;
      if (thread_id) rawEmail += `In-Reply-To: ${in_reply_to || ''}\r\nReferences: ${references || ''}\r\n`;
      rawEmail += `\r\n${emailBody}`;
      const encoded = Buffer.from(rawEmail).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      const payload = JSON.stringify({ raw: encoded, ...(thread_id ? { threadId: thread_id } : {}) });
      const sendData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send',
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
          let raw = ''; res.on('data', c => raw += c);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw)); } });
        });
        req.on('error', reject); req.write(payload); req.end();
      });
      result = sendData;
    }

    else if (action === 'gmail_ai_reply') {
      const { from, subject, body: emailBody } = body;
      const SYSTEM = `Sos el asistente de ventas de RhinosApp — CRM para distribuidoras de alimentos en Argentina.
Respondés emails en nombre de RhinosApp con tono profesional, directo y cercano. Nunca corporativo.
Objetivo: convertir leads en demos, responder consultas con claridad, manejar objeciones.
Web: rhinosapp.vercel.app | WhatsApp: +54 9 11 6822-3306 | Demo: calendly.com/comercial-rhinosapp
Firmá siempre como: Equipo RhinosApp 🦏`;
      const prompt = `Generá una respuesta profesional para este email recibido en comercial@rhinosapp.com:

DE: ${from}
ASUNTO: ${subject}
CUERPO: ${emailBody}

La respuesta debe:
- Ser directa y accionable
- Usar español rioplatense
- Incluir CTA claro (demo, WhatsApp o web según corresponda)
- Tener firma de RhinosApp
- Máximo 5 párrafos cortos`;
      const reply = await anthropicFetch([{ role: 'user', content: prompt }], SYSTEM);
      result = { reply };
    }

    else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    return res.status(200).json(result);
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
