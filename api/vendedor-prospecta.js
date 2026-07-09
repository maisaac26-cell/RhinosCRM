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

// Ciudades específicas para búsquedas más granulares
const CIUDADES_ARGENTINA = [
  'Quilmes', 'Avellaneda', 'Lanús', 'Lomas de Zamora', 'Morón',
  'San Isidro', 'Vicente López', 'Tigre', 'San Martín Buenos Aires', 'Tres de Febrero',
  'Merlo Buenos Aires', 'Moreno Buenos Aires', 'Florencio Varela', 'Berazategui',
  'Bahía Blanca', 'Tandil', 'Pergamino', 'San Nicolás de los Arroyos',
  'Junín Buenos Aires', 'Necochea', 'Olavarría', 'Zárate', 'Campana Buenos Aires',
  'Pilar Buenos Aires', 'Luján Buenos Aires', 'Azul Buenos Aires', 'Chivilcoy',
  'Río Cuarto Córdoba', 'Villa María Córdoba', 'San Francisco Córdoba',
  'Bell Ville Córdoba', 'Río Tercero', 'Villa Carlos Paz', 'Alta Gracia',
  'Rafaela Santa Fe', 'Venado Tuerto', 'Reconquista Santa Fe', 'Santo Tomé Santa Fe',
  'San Rafael Mendoza', 'Godoy Cruz', 'Guaymallén', 'Maipú Mendoza',
  'San Miguel de Tucumán', 'Yerba Buena Tucumán',
  'Salta capital', 'Jujuy capital', 'Bariloche', 'San Juan capital',
  'Corrientes capital', 'Resistencia Chaco', 'Posadas Misiones', 'Paraná Entre Ríos',
];

// Mapeo provincia/ciudad → código de estado ML (ISO 3166-2 AR)
const ML_ESTADOS = {
  'Buenos Aires': 'AR-B', 'La Plata': 'AR-B', 'Mar del Plata': 'AR-B',
  'Quilmes': 'AR-B', 'Avellaneda': 'AR-B', 'Lanús': 'AR-B',
  'Rosario': 'AR-S', 'Santa Fe': 'AR-S', 'Rafaela': 'AR-S',
  'Córdoba': 'AR-X', 'Río Cuarto': 'AR-X', 'Villa María': 'AR-X',
  'Mendoza': 'AR-M', 'San Rafael': 'AR-M',
  'Tucumán': 'AR-T', 'San Miguel de Tucumán': 'AR-T',
  'Salta': 'AR-A', 'Entre Ríos': 'AR-E', 'Paraná': 'AR-E',
  'Misiones': 'AR-N', 'Posadas': 'AR-N',
  'Chaco': 'AR-H', 'Resistencia': 'AR-H',
  'Corrientes': 'AR-W', 'San Juan': 'AR-J',
  'Neuquén': 'AR-Q', 'Río Negro': 'AR-R', 'Bariloche': 'AR-R',
  'Jujuy': 'AR-Y', 'Santiago del Estero': 'AR-G',
  'San Luis': 'AR-D', 'La Pampa': 'AR-L', 'CABA': 'AR-C',
};

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

function calcScore(email, website, rating, reviews, phone) {
  let s = 0;
  if (website && !/google\.com\/maps|goo\.gl|facebook\.com/i.test(website)) s += 25;
  if (email && !/@(gmail|hotmail|yahoo|outlook|live)\./i.test(email)) s += 25;
  if (rating && rating >= 4.0) s += 20;
  if (reviews && reviews >= 20) s += 15;
  if (phone) s += 15;
  return s;
}

function buildNotas(rating, reviews, address, fuente) {
  const parts = [];
  if (rating) parts.push(`${rating}★ en Google (${reviews || 0} reseñas)`);
  if (address) parts.push(address);
  if (fuente === 'pa') parts.push('Páginas Amarillas');
  return parts.join(' · ');
}

// Retorna true solo si el número parece móvil argentino (WhatsApp-compatible)
function isMobileAR(phone) {
  if (!phone) return false;
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('549')) p = p.slice(3);
  else if (p.startsWith('54')) p = p.slice(2);
  if (p.startsWith('0')) p = p.slice(1);
  if (p.length < 9 || p.length > 10) return false;
  if (/^(800|810|610)/.test(p)) return false;           // líneas 0800
  if (p.startsWith('11') && p[2] === '4') return false; // fijos CABA: 114xxx-xxxx
  return true;
}

function toSlug(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
    const detUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,website,formatted_address,rating,user_ratings_total&language=es&key=${apiKey}`;
    const det = await httpGet(detUrl);
    let detail;
    try { detail = JSON.parse(det.body).result || {}; } catch { detail = {}; }
    enriched.push({
      id:      place.place_id,
      name:    detail.name || place.name,
      address: detail.formatted_address || place.formatted_address || '',
      phone:   detail.formatted_phone_number || '',
      website: detail.website || '',
      rating:  detail.rating || place.rating || 0,
      reviews: detail.user_ratings_total || place.user_ratings_total || 0,
    });
    await new Promise(r => setTimeout(r, 200));
  }
  return enriched;
}

// ── Mercado Libre API ─────────────────────────────────────────────────────────

async function searchMercadoLibre(query, provincia, maxResults) {
  try {
    const state = ML_ESTADOS[provincia] || ML_ESTADOS[provincia.split(' ')[0]] || 'AR-B';
    const q = encodeURIComponent(query);
    const r = await httpGet(`https://api.mercadolibre.com/sites/MLA/search?q=${q}&state=${state}&official_store=all&limit=50`);
    let data;
    try { data = JSON.parse(r.body); } catch { return []; }

    const storeIds = new Set();
    for (const item of (data.results || [])) {
      if (item.official_store_id) storeIds.add(item.official_store_id);
    }

    const enriched = [];
    for (const storeId of [...storeIds].slice(0, maxResults)) {
      const sr = await httpGet(`https://api.mercadolibre.com/sites/MLA/official_stores/${storeId}`);
      let store;
      try { store = JSON.parse(sr.body); } catch { continue; }
      if (!store || store.error || !store.name) continue;
      const website = store.site_url || '';
      if (!website || website.includes('mercadolibre')) continue;
      enriched.push({
        id:      'ml_' + storeId,
        name:    store.name,
        address: store.location?.address_line || '',
        phone:   '',
        website,
      });
      await new Promise(r => setTimeout(r, 250));
    }
    return enriched;
  } catch { return []; }
}

// ── Páginas Amarillas AR ──────────────────────────────────────────────────────

const PA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function parsePAHtml(html) {
  const results = [];

  // Strategy 1: JSON-LD structured data (más confiable — lo inyectan para SEO)
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      const items = [];
      if (Array.isArray(obj)) items.push(...obj);
      else if (obj['@graph']) items.push(...obj['@graph']);
      else items.push(obj);
      for (const item of items) {
        const type = [].concat(item['@type'] || []).join(' ');
        if (!/LocalBusiness|FoodEstablishment|Store|AutoRepair|Restaurant|Pharmacy|ProfessionalService|HealthAndBeauty|HomeAndConstruction/i.test(type)) continue;
        if (!item.name || item.name.length < 2) continue;
        const addr = typeof item.address === 'string' ? item.address
          : [item.address?.streetAddress, item.address?.addressLocality].filter(Boolean).join(', ');
        results.push({
          id:      'pa_' + toSlug(item.name).slice(0, 20) + '_' + Math.random().toString(36).slice(2, 6),
          name:    item.name.trim(),
          phone:   (item.telephone || '').replace(/[()]/g, '').trim(),
          email:   item.email || '',
          website: item.url || '',
          address: addr,
          rating:  parseFloat(item.aggregateRating?.ratingValue) || 0,
          reviews: parseInt(item.aggregateRating?.reviewCount)   || 0,
        });
      }
    } catch {}
  }

  // Strategy 2: tel:/mailto: links + nombre en heading cercano
  if (results.length < 3) {
    const chunks = html.split(/(?=<(?:article|li)[^>]*>)/i).slice(1);
    for (const chunk of chunks) {
      const phoneM = chunk.match(/href="tel:([^"]+)"/i);
      const emailM = chunk.match(/href="mailto:([^"@]{1,50}@[^"?]{3,60})"/i);
      const siteM  = chunk.match(/href="(https?:\/\/(?!(?:www\.)?paginasamarillas)[^"?#]{5,80})"/i);
      const nameM  = chunk.match(/<h[2-4][^>]*>([^<]{2,80})<\/h[2-4]>/i)
        || chunk.match(/class="[^"]*(?:name|empresa|title|heading|razon)[^"]*"[^>]*>([^<]{2,80})</i);
      const name = nameM ? nameM[1].replace(/<[^>]+>/g, '').trim() : '';
      if (name.length < 3) continue;
      const email = emailM ? emailM[1].trim() : '';
      if (!email && !siteM && !phoneM) continue;
      results.push({
        id:      'pa_' + toSlug(name).slice(0, 20) + '_' + Math.random().toString(36).slice(2, 6),
        name,
        phone:   phoneM ? phoneM[1].trim() : '',
        email:   SKIP_EMAIL.test(email) ? '' : email,
        website: siteM ? siteM[1] : '',
        address: '',
        rating:  0,
        reviews: 0,
      });
    }
  }

  return results;
}

async function searchPaginasAmarillas(rubro, provincia, maxResults) {
  const base = `https://www.paginasamarillas.com.ar/${toSlug(rubro)}/en/${toSlug(provincia)}`;

  // Fetch 3 pages in parallel — 3x más cobertura con el mismo tiempo
  const [html1, html2, html3] = await Promise.all([
    fetchHtml(`${base}/p-1`, PA_UA),
    fetchHtml(`${base}/p-2`, PA_UA),
    fetchHtml(`${base}/p-3`, PA_UA),
  ]);

  const seen = new Set();
  const results = [];
  for (const html of [html1, html2, html3]) {
    if (!html || html.length < 800) continue;
    for (const r of parsePAHtml(html)) {
      const key = (r.name || '').toLowerCase().replace(/\s+/g, '').slice(0, 15);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      results.push(r);
    }
  }

  return results.slice(0, maxResults * 2); // entregar más para que el batch tenga más opciones
}

// ── Email extraction ──────────────────────────────────────────────────────────

const EMAIL_RE   = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const SKIP_EMAIL = /noreply|no-reply|donotreply|example\.com|ejemplo\.|sentry\.|wix\.|wordpress\.|schema\.|googleapis|@2x|\.png|\.jpg|tuemail@|youremail@|yourmail@|email@email|@email\.com|yourstore\.|yourdomain\.|miempresa\.|tuempresa\.|yoursite\.|mysite\.|info@info\.|test@test\.|demo@|hola@hola\.|contact@contact\.|nombre@|tu@|returns@|unsubscribe@|bounce@|mailer-daemon@|postmaster@|spam@|abuse@|%[0-9a-f]{2}/i;

function fetchHtml(pageUrl, ua) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(''), 3500);
    try {
      const u = new URL(pageUrl.startsWith('http') ? pageUrl : 'https://' + pageUrl);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'GET',
        headers: {
          'User-Agent': ua || 'Mozilla/5.0 (compatible; Googlebot/2.1)',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-AR,es;q=0.9',
        },
        timeout: 3000,
      }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          clearTimeout(timeout);
          const loc = res.headers.location.startsWith('http') ? res.headers.location : `https://${u.hostname}${res.headers.location}`;
          fetchHtml(loc, ua).then(resolve);
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
  return [...new Set((html.match(EMAIL_RE) || []).filter(e => {
    if (SKIP_EMAIL.test(e)) return false;
    if (e.length >= 80) return false;
    const tld = e.split('.').pop();
    if (tld.length > 10) return false; // rechaza TLDs raros como ".defaultKart"
    return true;
  }))];
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
    const cfgRows = await sbGet('rhinos_config?key=in.(vendedor_rubro_auto,vendedor_provincias_auto,vendedor_cantidad_auto,vendedor_minimo_auto,vendedor_minimo_busqueda,vendedor_fuente_auto,vendedor_activo,vendedor_hora_prospecta)');
    const cfgMap  = {};
    cfgRows.forEach(r => { cfgMap[r.key] = r.value; });

    // Schedule guard — skip unless ?force=1
    const force = (req.query || {}).force === '1';
    if (!force) {
      const activo = cfgMap.vendedor_activo || 'true';
      // 'solo_prospecta' sigue corriendo — solo se pausan los emails
      if (activo === 'false') return res.json({ ok: true, skipped: true, reason: 'sistema pausado', summary });
      const horaProspecta = parseInt(cfgMap.vendedor_hora_prospecta || '21', 10);
      const horaAR = ((new Date().getUTCHours() - 3) + 24) % 24;
      if (horaAR !== horaProspecta) {
        return res.json({ ok: true, skipped: true, reason: `fuera de horario (son las ${horaAR}:00 AR, configurado ${horaProspecta}:00)`, summary });
      }
    }

    const cantidad        = parseInt(cfgMap.vendedor_cantidad_auto    || '50',  10);
    const minimo          = parseInt(cfgMap.vendedor_minimo_auto      || '10',  10);
    const minimoBusqueda  = parseInt(cfgMap.vendedor_minimo_busqueda  || '2',   10);
    const fuente          = (cfgMap.vendedor_fuente_auto || 'google').trim();

    const rubroFijo      = (cfgMap.vendedor_rubro_auto || '').trim();
    const provinciasConf = (cfgMap.vendedor_provincias_auto || '').split(',').map(s => s.trim()).filter(Boolean);

    // Obtener emails y empresas ya en el pipeline para deduplicar
    const existentes = await sbGet('rhinos_prospectos?select=email,empresa&limit=5000');
    const emailsYaEnPipeline   = new Set(existentes.map(r => (r.email   || '').toLowerCase().trim()).filter(Boolean));
    const empresasYaEnPipeline = new Set(existentes.map(r => (r.empresa || '').toLowerCase().trim()).filter(Boolean));

    // Cargar blacklist (no crítico si la tabla no existe aún)
    let blacklistDomains = new Set();
    let blacklistEmpresas = [];
    try {
      const bl = await sbGet('rhinos_blacklist?select=dominio,empresa&limit=500');
      bl.forEach(r => {
        if (r.dominio) blacklistDomains.add(r.dominio.toLowerCase().trim());
        if (r.empresa) blacklistEmpresas.push(r.empresa.toLowerCase().trim());
      });
    } catch {}

    const nuevos = [];
    const startTime  = Date.now();
    const TIME_LIMIT = 240000; // 240s — margen de 60s antes del timeout de 300s

    while (nuevos.length < minimo && (Date.now() - startTime) < TIME_LIMIT) {
      const rubro    = rubroFijo || pick(RUBROS_RANDOM);
      // Alternar entre ciudades específicas y provincias para mayor cobertura
      const useCity  = !provinciasConf.length && Math.random() < 0.5;
      const provincia = provinciasConf.length
        ? provinciasConf[summary.intentos % provinciasConf.length]
        : useCity ? pick(CIUDADES_ARGENTINA) : pick(PROVINCIAS_RANDOM);
      summary.intentos++;
      if (!summary.rubros.includes(rubro))         summary.rubros.push(rubro);
      if (!summary.provincias.includes(provincia)) summary.provincias.push(provincia);

      // Elegir fuente: alternancia 3-vías (Google / PA / ML)
      const usarPA     = fuente === 'paginas_amarillas' || (fuente === 'ambos' && summary.intentos % 3 === 2);
      const usarML     = fuente === 'mercadolibre'      || (fuente === 'ambos' && summary.intentos % 3 === 1);
      const usarGoogle = fuente === 'google'            || (fuente === 'ambos' && summary.intentos % 3 === 0);

      let places = [];
      if (usarGoogle) places = await searchPlaces(rubro, provincia, PLACES_KEY);
      if (usarPA)     places = [...places, ...(await searchPaginasAmarillas(rubro, provincia, 15))];
      if (usarML)     places = [...places, ...(await searchMercadoLibre(rubro, provincia, 5))];
      summary.buscados += places.length;

      let encontradosEnEstaIteracion = 0;

      // Paralelizar scraping en batches de 5 para no bloquear todo el tiempo en secuencial
      const BATCH = 5;
      for (let bi = 0; bi < places.length; bi += BATCH) {
        if (nuevos.length >= cantidad || (Date.now() - startTime) >= TIME_LIMIT) break;

        const batch = places.slice(bi, bi + BATCH);
        const enriched = await Promise.all(batch.map(async (place) => {
          const isPAResult = (place.id || '').startsWith('pa_');
          let emails = [];
          if (place.email && !SKIP_EMAIL.test(place.email)) {
            emails = [place.email];
          } else if (place.website) {
            emails = await findEmailsForSite(place.website);
          }
          return { place, emails, isPAResult };
        }));

        for (const { place, emails, isPAResult } of enriched) {
          if (nuevos.length >= cantidad) break;
          if (!emails.length) continue;

          // Teléfono: solo guardar si es móvil argentino (compatible con WhatsApp)
          const telGuardar = isMobileAR(place.phone) ? (place.phone || '') : '';

          const empresaNorm = (place.name || '').toLowerCase().trim();
          // 1 solo prospecto por empresa — si ya está en el pipeline, skip toda la empresa
          if (empresasYaEnPipeline.has(empresaNorm)) { summary.duplicados++; continue; }
          if (blacklistEmpresas.some(bl => empresaNorm.includes(bl))) { summary.duplicados++; continue; }

          for (const email of emails) {
            if (nuevos.length >= cantidad) break;
            const emailNorm = email.toLowerCase().trim();
            if (emailsYaEnPipeline.has(emailNorm)) { summary.duplicados++; continue; }

            // Blacklist check por dominio
            const domain = emailNorm.split('@')[1] || '';
            if (blacklistDomains.has(domain)) { summary.duplicados++; continue; }

            emailsYaEnPipeline.add(emailNorm);
            empresasYaEnPipeline.add(empresaNorm); // evitar 2do email de la misma empresa en este run
            summary.con_email++;
            encontradosEnEstaIteracion++;

            nuevos.push({
              id:              place.id + '_' + emailNorm.replace(/[^a-z0-9]/g, '').slice(0, 30) + '_' + Date.now().toString(36),
              empresa:         place.name,
              nombre_contacto: '',
              email:           email,
              telefono:        telGuardar,
              website:         place.website || '',
              rubro:           rubro,
              localidad:       provincia,
              notas:           buildNotas(place.rating, place.reviews, place.address, isPAResult ? 'pa' : ''),
              ia_score:        calcScore(email, place.website, place.rating, place.reviews, telGuardar),
              origen:          isPAResult ? 'auto_pa' : (place.id || '').startsWith('ml_') ? 'auto_ml' : 'auto_google',
              estado:          'nuevo',
              ia_contactado:   false,
              ia_followup_count: 0,
              ia_reply:        false,
              ia_wa_enviado:   false,
              created_at:      new Date().toISOString(),
              updated_at:      new Date().toISOString(),
            });
            break; // 1 solo email por empresa
          }
        }
      }

      summary.errors.push({ iteracion: summary.intentos, rubro, provincia, encontrados: encontradosEnEstaIteracion });
    }

    if (nuevos.length) {
      await sbReq('POST', 'rhinos_prospectos', nuevos);
      summary.agregados = nuevos.length;
    }

    // Reporte automático vía push notification
    if (summary.agregados > 0) {
      const rubros = summary.rubros.slice(0, 3).join(', ');
      const pushPayload = JSON.stringify({
        action: 'send',
        title: `🔍 ${summary.agregados} prospectos nuevos`,
        body: `Rubros: ${rubros}. ${summary.con_email} con email · ${summary.duplicados} duplicados saltados`,
        tag: 'prospeccion',
      });
      const pushReq = https.request({
        hostname: 'rhinos-crm.vercel.app', path: '/api/push', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pushPayload) },
      }, r => { r.resume(); });
      pushReq.on('error', () => {});
      pushReq.write(pushPayload); pushReq.end();
    }

    return res.json({ ok: true, summary });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message, summary });
  }
};
