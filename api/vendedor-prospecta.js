// Cron 6pm ART (21:00 UTC) — búsqueda automática de prospectos con email.
// 1. Lee config de rubro/provincia (o elige aleatorio).
// 2. Busca en Google Places y extrae emails de los sitios web.
// 3. Deduplica contra rhinos_prospectos (nunca agrega el mismo email dos veces).
// 4. Agrega los nuevos al pipeline con estado='nuevo' para que el cron de 9am los contacte.
'use strict';
const https = require('https');
const http  = require('http');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

const RUBROS_RANDOM = [
  // Distribución y mayoristas
  'distribuidora de alimentos', 'distribuidora de bebidas', 'mayorista de alimentos',
  'distribuidora de lácteos', 'distribuidora de carnes y embutidos',
  'supermercado mayorista', 'distribuidora de productos de limpieza',
  'distribuidora de congelados', 'distribuidora de panificados',
  'distribuidora de frutas y verduras', 'distribuidora de indumentaria',
  'distribuidora de electrónica', 'farmacia mayorista', 'cash and carry Argentina',

  // Comercio minorista de alimentos
  'kiosco', 'almacén de barrio', 'fiambrería', 'carnicería',
  'verdulería y frutería', 'panadería y confitería', 'heladería',
  'rotisería', 'dietética', 'mercado de barrio', 'despensa',
  'vinoteca', 'cervecería artesanal', 'empresa de catering',

  // Gastronomía y atención al público
  'restaurante', 'pizzería', 'hamburguesería', 'bar y cafetería',
  'confitería y café', 'sushi bar', 'bodegón', 'parrilla',
  'delivery de comida', 'fast food Argentina',

  // Ferretería, construcción y hogar
  'ferretería', 'corralón de materiales', 'maderera',
  'pinturería', 'sanitarios y plomería', 'empresa de construcción',
  'electricidad materiales', 'cerrajería',

  // Indumentaria y calzado
  'negocio de ropa', 'boutique de indumentaria', 'zapatería',
  'local de ropa deportiva', 'lencería', 'marroquinería',
  'negocios de telas y mercería',

  // Electrónica, tecnología y telefonía
  'negocio de celulares', 'tienda de informática', 'electrodomésticos',
  'tienda de electrónica', 'servicio técnico de computadoras',

  // Salud y belleza
  'farmacia', 'perfumería', 'peluquería y barbería', 'estética y spa',
  'óptica', 'ortopedia', 'dietética y naturismo',

  // Automotriz
  'taller mecánico', 'lubricentro y gomería', 'repuestos de autos',
  'concesionaria de autos usados', 'lavadero de autos',

  // Mascotas
  'veterinaria', 'pet shop', 'estética canina',

  // Librería, juguetería y entretenimiento
  'librería y papelería', 'juguetería', 'bazar y regalería',
  'artículos de cotillón', 'disquería y multimedia',

  // Servicios al público con stock
  'vivero y jardinería', 'pesca y camping', 'óptica',
  'artículos de limpieza y cotillón', 'bicicletería',
  'mueblería y decoración', 'colchonería', 'artículos de deporte',
  'floristería', 'pyme industrial Argentina',
];

const PROVINCIAS_RANDOM = [
  'Buenos Aires', 'Córdoba', 'Santa Fe', 'Rosario', 'Mendoza', 'Tucumán',
  'Mar del Plata', 'La Plata', 'Salta', 'Entre Ríos', 'Misiones',
  'Chaco', 'Corrientes', 'San Juan', 'Neuquén', 'Río Negro',
  'Jujuy', 'Santiago del Estero', 'San Luis', 'La Pampa',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Supabase ──────────────────────────────────────────────────────────────────

function sbReq(method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: new URL(SB_URL).hostname,
      path: '/rest/v1/' + path, method,
      headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sbGet(path) {
  const r = await sbReq('GET', path);
  return Array.isArray(r) ? r : [];
}

// ── Google Places ─────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => resolve({ status: 0, body: '{}' }), 8000);
    try {
      const req = lib.get(url, { timeout: 7000 }, (res) => {
        let raw = ''; res.on('data', c => raw += c);
        res.on('end', () => { clearTimeout(timeout); resolve({ status: res.statusCode, body: raw }); });
        res.on('error', () => { clearTimeout(timeout); resolve({ status: 0, body: '{}' }); });
      });
      req.on('error', () => { clearTimeout(timeout); resolve({ status: 0, body: '{}' }); });
      req.on('timeout', () => { req.destroy(); clearTimeout(timeout); resolve({ status: 0, body: '{}' }); });
    } catch { clearTimeout(timeout); resolve({ status: 0, body: '{}' }); }
  });
}

async function searchPlaces(query, location, apiKey) {
  const q = encodeURIComponent(`${query} en ${location} Argentina`);
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&type=establishment&language=es&region=ar&key=${apiKey}`;
  const r = await httpGet(url);
  let data;
  try { data = JSON.parse(r.body); } catch { return []; }
  const results = data.results || [];

  const enriched = [];
  for (const place of results.slice(0, 20)) {
    if (!place.place_id) continue;
    const detUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,website,formatted_address&language=es&key=${apiKey}`;
    const det = await httpGet(detUrl);
    let detail;
    try { detail = JSON.parse(det.body).result || {}; } catch { detail = {}; }
    enriched.push({
      id:       place.place_id,
      name:     detail.name || place.name,
      address:  detail.formatted_address || place.formatted_address || '',
      phone:    detail.formatted_phone_number || '',
      website:  detail.website || '',
    });
    await new Promise(r => setTimeout(r, 200));
  }
  return enriched;
}

// ── Email extraction ──────────────────────────────────────────────────────────

const EMAIL_RE   = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const SKIP_EMAIL = /noreply|no-reply|donotreply|example\.com|sentry\.|wix\.|wordpress\.|schema\.|googleapis|@2x|\.png|\.jpg/i;

function fetchHtml(pageUrl) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(''), 6000);
    try {
      const u = new URL(pageUrl.startsWith('http') ? pageUrl : 'https://' + pageUrl);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Accept': 'text/html' },
        timeout: 5000,
      }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          clearTimeout(timeout);
          const loc = res.headers.location.startsWith('http') ? res.headers.location : `https://${u.hostname}${res.headers.location}`;
          fetchHtml(loc).then(resolve);
          return;
        }
        let html = '';
        res.on('data', c => { html += c; if (html.length > 200000) res.destroy(); });
        res.on('end', () => { clearTimeout(timeout); resolve(html); });
        res.on('error', () => { clearTimeout(timeout); resolve(''); });
      });
      req.on('error', () => { clearTimeout(timeout); resolve(''); });
      req.on('timeout', () => { req.destroy(); clearTimeout(timeout); resolve(''); });
      req.end();
    } catch { clearTimeout(timeout); resolve(''); }
  });
}

function extractEmails(html) {
  return [...new Set((html.match(EMAIL_RE) || []).filter(e => !SKIP_EMAIL.test(e) && e.includes('.') && e.length < 80))];
}

async function findEmailsForSite(website) {
  if (!website) return [];
  try {
    const base = website.startsWith('http') ? new URL(website).origin : 'https://' + website;
    const [mainHtml, contactHtml] = await Promise.all([
      fetchHtml(base),
      fetchHtml(base + '/contacto').catch(() => ''),
    ]);
    let emails = [...new Set([...extractEmails(mainHtml), ...extractEmails(contactHtml)])];
    if (!emails.length) {
      const en = await fetchHtml(base + '/contact').catch(() => '');
      emails = extractEmails(en);
    }
    return emails.slice(0, 5); // máximo 5 emails por sitio
  } catch { return []; }
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const PLACES_KEY = process.env.GOOGLE_PLACES_KEY;
  if (!PLACES_KEY) return res.json({ ok: false, error: 'GOOGLE_PLACES_KEY no configurada' });

  const summary = { buscados: 0, con_email: 0, duplicados: 0, agregados: 0, intentos: 0, rubros: [], provincias: [], errors: [] };

  try {
    // Cargar config
    const cfgRows = await sbGet('rhinos_config?key=in.(vendedor_rubro_auto,vendedor_provincias_auto,vendedor_cantidad_auto,vendedor_minimo_auto,vendedor_minimo_busqueda)');
    const cfgMap  = {};
    cfgRows.forEach(r => { cfgMap[r.key] = r.value; });

    const cantidad        = parseInt(cfgMap.vendedor_cantidad_auto    || '50',  10); // máximo total
    const minimo          = parseInt(cfgMap.vendedor_minimo_auto      || '10',  10); // mínimo total diario
    const minimoBusqueda  = parseInt(cfgMap.vendedor_minimo_busqueda  || '2',   10); // mínimo por iteración

    const rubroFijo      = (cfgMap.vendedor_rubro_auto || '').trim();
    const provinciasConf = (cfgMap.vendedor_provincias_auto || '').split(',').map(s => s.trim()).filter(Boolean);

    // Obtener emails ya en el pipeline para deduplicar
    const existentes = await sbGet('rhinos_prospectos?select=email&limit=5000');
    const emailsYaEnPipeline = new Set(existentes.map(r => (r.email || '').toLowerCase().trim()).filter(Boolean));

    const nuevos = [];
    const startTime  = Date.now();
    const TIME_LIMIT = 240000; // 240s — margen de 60s antes del timeout de 300s

    while (nuevos.length < minimo && (Date.now() - startTime) < TIME_LIMIT) {
      const rubro     = rubroFijo || pick(RUBROS_RANDOM);
      const provincia = provinciasConf.length ? provinciasConf[summary.intentos % provinciasConf.length] : pick(PROVINCIAS_RANDOM);
      summary.intentos++;
      if (!summary.rubros.includes(rubro))         summary.rubros.push(rubro);
      if (!summary.provincias.includes(provincia)) summary.provincias.push(provincia);

      const places = await searchPlaces(rubro, provincia, PLACES_KEY);
      summary.buscados += places.length;

      let encontradosEnEstaIteracion = 0;

      for (const place of places) {
        if (nuevos.length >= cantidad) break;
        if ((Date.now() - startTime) >= TIME_LIMIT) break;
        if (!place.website) continue;

        const emails = await findEmailsForSite(place.website);
        if (!emails.length) continue;

        for (const email of emails) {
          if (nuevos.length >= cantidad) break;
          const emailNorm = email.toLowerCase().trim();
          if (emailsYaEnPipeline.has(emailNorm)) { summary.duplicados++; continue; }

          emailsYaEnPipeline.add(emailNorm);
          summary.con_email++;
          encontradosEnEstaIteracion++;

          nuevos.push({
            id:              place.id + '_' + emailNorm.replace(/[^a-z0-9]/g, '').slice(0, 30) + '_' + Date.now().toString(36),
            empresa:         place.name,
            nombre_contacto: '',
            email:           email,
            telefono:        place.phone || '',
            website:         place.website || '',
            rubro:           rubro,
            localidad:       provincia,
            origen:          'auto_prospecta',
            estado:          'nuevo',
            ia_contactado:   false,
            ia_followup_count: 0,
            ia_reply:        false,
            created_at:      new Date().toISOString(),
            updated_at:      new Date().toISOString(),
          });
        }
      }

      // Si esta iteración rindió menos que el mínimo por búsqueda Y todavía no llegamos
      // al mínimo total, seguimos con otro rubro/provincia sin contar como "intento fallido".
      summary.errors.push({ iteracion: summary.intentos, rubro, provincia, encontrados: encontradosEnEstaIteracion });
    }

    if (nuevos.length) {
      await sbReq('POST', 'rhinos_prospectos', nuevos);
      summary.agregados = nuevos.length;
    }

    return res.json({ ok: true, summary });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message, summary });
  }
};
