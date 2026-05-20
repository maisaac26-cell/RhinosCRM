const https = require('https');

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

function igFetch(path, method, body) {
  const IG_TOKEN = process.env.IG_ACCESS_TOKEN;
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Method not allowed' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); } }

  const IG_ID = process.env.IG_ACCOUNT_ID;
  const { action } = body;

  try {
    let result;

    if (action === 'supabase_proxy') {
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
      // Paso 1: Solo crea el container y devuelve el ID (rápido, < 5 segundos)
      const { image_url, caption } = body;
      if (!image_url) throw new Error('Se requiere image_url');
      if (image_url.startsWith('blob:') || image_url.startsWith('data:')) {
        throw new Error('URL local — necesita subirse a un host público primero');
      }
      const containerPath = `${IG_ID}/media?image_url=${encodeURIComponent(image_url)}&caption=${encodeURIComponent(caption || '')}`;
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
      const SYS = `Sos experto en prompt engineering para DALL-E 3, especializado en crear un feed de Instagram cohesivo y premium para RhinosApp.

PRODUCTO: RhinosApp es un CRM/ERP para distribuidoras de alimentos en Argentina. Reemplaza Excel con una plataforma tech que da control total de stock, pedidos, cobranzas y facturación AFIP.

LOGO DE RHINOSAPP — SIEMPRE PRESENTE (elemento central o secundario en TODAS las imágenes):
El logo es un rinoceronte mecánico-cibernético con estas características EXACTAS que SIEMPRE deben aparecer:
• Cabeza de rinoceronte armada con placas de metal hexagonales y paneles geométricos, vista 3/4 mirando hacia la derecha
• Un ojo único circular cibernético con glow cyan brillante (#00e5cc)
• Cuerno masivo estilo cristal/holográfico con neón cyan luminoso, como una espada de luz
• Marco hexagonal geométrico rodeando la cabeza, con trazos de circuito electrónico en los bordes y nodos luminosos en los vértices
• Partículas y chispas cyan dispersas en la esquina superior derecha del hexágono
• Paleta: acero oscuro metálico + placas grises + brillo cyan/teal intenso como neón
• El rinoceronte emana energía y control — es poderoso, tech, dominante

ESTILO DE FEED (SIEMPRE consistente en TODAS las imágenes):
- Fondo: negro azulado profundo (#0d1117) — SIEMPRE este fondo, nunca blanco ni gris
- Acento principal: turquesa/cyan brillante con efecto glow (#00e5cc)
- Acento secundario: verde lima solo para elementos de éxito/CTA (#22c55e)
- Estilo: tech industrial premium — cyberpunk sofisticado, futurista pero sobrio
- Iluminación: dramática, rim lighting en cyan sobre el rinoceronte, sombras profundas, efectos neon suaves
- El logo del rinoceronte en hexágono SIEMPRE aparece — puede ser el elemento central dominante o integrado como marca de agua poderosa en una esquina
- Composición: minimalista, espacio negativo, el rinoceronte anclado visualmente con los otros elementos del post
- Calidad: ultra-detailed 3D render, cinematic depth of field, photorealistic metal materials
- NUNCA texto, letras, palabras ni números en la imagen

TABLA DE REFERENCIAS POR MÓDULO (el logo del rhino siempre presente + estos elementos secundarios):
- Stock/productos → cajas de cartón flotantes con auras cyan, gráficos de inventario holográficos alrededor del rhino
- Ventas/pedidos → rutas de entrega digitales con nodos luminosos, el rhino en el centro coordinando
- Cobranzas → flujos de dinero digitalizados en circuitos, monedas flotantes, el rhino controlando el caos
- Clientes → red de conexiones hexagonales emanando desde el rhino
- Panel/reportes → pantallas holográficas con datos flotando alrededor del rhino
- AFIP/facturación → documentos digitales sellados con el escudo del rhino
- Proveedores → cadena de suministro digital con el rhino como nodo central
- Comparación Excel → planilla Excel fragmentándose/quemándose mientras el rhino emerge victorioso
- General/IA → el cerebro del rhino con conexiones neurales cyan expandiéndose`;

      const { caption } = body;
      const captionContext = caption
        ? `\nCAPTION DEL POST (el texto que va a acompañar esta imagen — la imagen DEBE reforzar visualmente este mensaje):\n"${caption}"\n`
        : '';

      const pr = `Generá un prompt en inglés para una imagen de Instagram de RhinosApp.
${captionContext}
MÓDULO/TEMA: ${modulo}
ÁNGULO: ${angulo || 'el más impactante visualmente para este módulo'}
FORMATO: ${formato}
TONO: ${tono}

${caption ? `IMPORTANTE: La imagen debe ser la expresión VISUAL del mensaje del caption. Identificá la emoción central, el dolor o la solución que describe el texto, y traducila a elementos visuales concretos. Si el caption habla de "no saber cuánto te deben", mostrá flujos de dinero caóticos transformándose en orden. Si habla de "control", mostrá un panel de control dominante. Si habla de "Excel", mostrá una planilla fragmentándose.` : ''}

El prompt DEBE:
1. Empezar SIEMPRE con: "Cinematic 3D render, ultra-detailed, deep dark navy-black background (#0d1117), glowing cyan neon accents (#00e5cc), dramatic rim lighting,"
2. Incluir OBLIGATORIAMENTE la descripción del logo: "cyberpunk mechanical armored rhinoceros head with hexagonal metal plates, 3/4 view facing right, single glowing cyan cybernetic eye, massive crystal-like luminous horn with intense cyan neon glow, surrounded by a geometric hexagonal frame with circuit board traces along the edges and glowing node dots at each vertex, cyan sparks and particles dispersing from upper-right corner of the hexagon, dark steel and metallic gray armor with cyan (#00e5cc) energy accents"
3. Describir el elemento visual temático del caption/módulo que rodea o complementa al rhino
4. Especificar: deep shadows, cyan rim lighting on the rhino, bokeh depth of field, volumetric cyan fog
5. Terminar SIEMPRE con: "no text, no letters, no words, no numbers, minimalist premium B2B tech aesthetic, cohesive Instagram feed visual"
6. Máximo 220 palabras

Respondé SOLO con el prompt en inglés, listo para usar.`;
      const imagePromptText = await anthropicFetch([{ role: 'user', content: pr }], SYS);
      result = { prompt: imagePromptText };
    }

    else if (action === 'extract_image_text') {
      const { caption } = body;
      const SYSTEM = `Sos especialista en marketing visual para RhinosApp — CRM para distribuidoras de alimentos en Argentina.
Extraés frases impactantes de captions para usar como texto sobre imágenes de Instagram.
Reglas: máximo 5 palabras para el titular, directo al dolor o beneficio, en español rioplatense, TODO EN MAYÚSCULAS.`;
      const prompt = `Del siguiente caption de Instagram, extraé el texto más impactante para poner sobre una imagen.

CAPTION:
"${caption.slice(0, 800)}"

Respondé SOLO con JSON válido, sin markdown:
{
  "titular": "3-5 PALABRAS EN MAYÚSCULAS que representen el mensaje central (ej: 'SIN EXCEL. SIN CAOS.' o '¿SABÉS CUÁNTO TE DEBEN?')",
  "subtitulo": "Una línea corta opcional de contexto en minúsculas (máx 6 palabras) o null",
  "cta": "rhinosapp.vercel.app"
}`;
      const raw = await anthropicFetch([{ role: 'user', content: prompt }], SYSTEM);
      try {
        const clean = raw.replace(/```json|```/g, '').trim();
        result = JSON.parse(clean);
      } catch(e) {
        result = { titular: 'CONTROLÁ TU NEGOCIO', subtitulo: 'Con RhinosApp', cta: 'rhinosapp.vercel.app' };
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
