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

    if (action === 'ig_publish') {
      const { image_url, caption } = body;
      if (!image_url) throw new Error('Se requiere image_url');

      // 1. Crear container
      const containerPath = `${IG_ID}/media?image_url=${encodeURIComponent(image_url)}&caption=${encodeURIComponent(caption || '')}`;
      const container = await igFetch(containerPath, 'POST');
      if (!container.id) throw new Error('Error creando container: ' + JSON.stringify(container));

      // 2. Esperar a que Instagram procese la imagen (status FINISHED)
      let status = 'IN_PROGRESS';
      let attempts = 0;
      while (status !== 'FINISHED' && attempts < 12) {
        await new Promise(r => setTimeout(r, 3000));
        const check = await igFetch(`${container.id}?fields=status_code`);
        status = check.status_code || 'IN_PROGRESS';
        if (status === 'ERROR' || status === 'EXPIRED') throw new Error('Instagram rechazó la imagen: ' + status);
        attempts++;
      }
      if (status !== 'FINISHED') throw new Error('Timeout procesando imagen en Instagram');

      // 3. Publicar
      const published = await igFetch(`${IG_ID}/media_publish?creation_id=${container.id}`, 'POST');
      if (!published.id) throw new Error('Error publicando: ' + JSON.stringify(published));
      result = { id: published.id, success: true };
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

ESTILO DE FEED (SIEMPRE consistente en TODAS las imágenes):
- Fondo: negro azulado profundo (#0d1117) — SIEMPRE este fondo, nunca blanco ni gris
- Acento principal: turquesa/cyan brillante con efecto glow (#00e5cc)
- Acento secundario: verde lima solo para elementos de éxito/CTA (#22c55e)
- Estilo: tech industrial premium — como un dashboard futurista de alta tecnología
- Iluminación: dramática, rim lighting en cyan, sombras profundas, efectos neon suaves
- Elementos recurrentes de marca: rinoceronte mecánico/robótico, hexágonos geométricos, circuitos electrónicos, partículas de datos flotantes, pantallas holográficas
- Composición: minimalista, mucho espacio negativo, UN elemento central dominante
- Calidad: ultra-detailed 3D render, cinematic depth of field, photorealistic materials
- NUNCA texto, letras, palabras ni números en la imagen

TABLA DE REFERENCIAS POR MÓDULO (usá para elegir el elemento visual central):
- Stock/productos → cajas de cartón flotantes con auras cyan, gráficos de inventario holográficos
- Ventas/pedidos → maletines digitales, rutas de entrega con nodos luminosos, cartas de pedido flotantes
- Cobranzas → monedas y billetes digitalizados, flujos de dinero en circuitos, contadores flotantes
- Clientes → red de conexiones humanas digitalizadas, perfiles en hexágonos
- Panel/reportes → múltiples pantallas holográficas con gráficos, datos en el aire
- AFIP/facturación → documentos digitales sellados, escudos de seguridad glowing
- Proveedores → cadena de suministro digital, engranajes mecánicos
- Comparación Excel → hoja Excel fragmentándose/quemándose, renaciendo como interfaz tech
- General/IA → cerebro mecánico de rinoceronte con conexiones neurales cyan`;

      const pr = `Generá un prompt en inglés para DALL-E 3 para una imagen de Instagram de RhinosApp.

MÓDULO/TEMA: ${modulo}
ÁNGULO: ${angulo || 'el más impactante visualmente para este módulo'}
FORMATO: ${formato}
TONO: ${tono}

El prompt DEBE:
1. Empezar SIEMPRE con: "Cinematic 3D render, ultra-detailed, deep dark navy-black background (#0d1117), glowing cyan neon accents (#00e5cc), dramatic rim lighting,"
2. Describir UN elemento visual central específico y poderoso basado en el módulo (ver tabla de referencias)
3. Incluir: mechanical robotic rhino silhouette OR hexagonal geometric structures, floating data particles, electronic circuit patterns
4. Especificar: deep shadows, cyan rim lighting, bokeh depth of field, volumetric fog with cyan glow
5. Terminar SIEMPRE con: "no text, no letters, no words, no numbers, minimalist premium B2B tech aesthetic, cohesive Instagram feed visual"
6. Máximo 200 palabras

Respondé SOLO con el prompt en inglés, listo para usar en DALL-E 3.`;
      const imagePromptText = await anthropicFetch([{ role: 'user', content: pr }], SYS);
      result = { prompt: imagePromptText };
    }

    else if (action === 'generate_image') {
      const { prompt, size = '1024x1024', quality = 'hd', variations = 1 } = body;
      const OPENAI_KEY = process.env.OPENAI_API_KEY;

      const sizeMap = {
        'square': '1024x1024',
        'portrait': '1024x1792',
        'landscape': '1792x1024'
      };
      const finalSize = sizeMap[size] || size;
      const count = Math.min(Math.max(1, +variations), 3);

      // DALL-E 3 solo acepta n=1, generamos en paralelo
      const requests = Array.from({ length: count }, () => {
        const payload = JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: finalSize, quality });
        return new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/images/generations',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + OPENAI_KEY,
              'Content-Length': Buffer.byteLength(payload)
            }
          }, (res) => {
            let raw = ''; res.on('data', c => raw += c);
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw.slice(0, 200))); } });
          });
          req.on('error', reject); req.write(payload); req.end();
        });
      });

      const results = await Promise.all(requests);

      // Verificar errores de OpenAI y mostrarlos claramente
      for (const r of results) {
        if (r.error) throw new Error('OpenAI: ' + (r.error.message || JSON.stringify(r.error)));
      }

      const urls = results.map(r => r.data?.[0]?.url).filter(Boolean);
      if (!urls.length) throw new Error('OpenAI no devolvió imágenes. Verificá que OPENAI_API_KEY esté configurada en Vercel.');

      result = { urls, url: urls[0] };
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
