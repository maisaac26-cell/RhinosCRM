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

    if (action === 'get_metrics') {
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
      const SYSTEM = `Sos el agente de marketing de RhinosApp — CRM para distribuidores de alimentos (quesos, fiambres, bebidas) en Argentina.
Identidad visual: fondo oscuro #0d1117, acento turquesa #00e5cc, verde CTA #22c55e. Logo: rinoceronte robótico en hexágono.
Cliente objetivo: dueño de distribuidora, 35-55 años, acostumbrado a Excel y WhatsApp.
Tono: profesional, disruptivo, minimalista premium. Nunca corporativo.`;
      const prompt = `Generá contenido para Instagram de RhinosApp:
MÓDULO: ${modulo}
ÁNGULO: ${angulo || 'libre'}
FORMATO: ${formato}
TONO: ${tono}
CTA: ${cta}

Entregá:
1. CAPTION COMPLETO (listo para copiar, con emojis estratégicos)
2. HASHTAGS (15-20)
3. IDEAS VISUALES (2-3 opciones concretas para el diseño en Canva con colores de marca: fondo #0d1117, acento #00e5cc)
4. TIMING (mejor día y hora)`;
      const reply = await anthropicFetch([{ role: 'user', content: prompt }], SYSTEM);
      result = { reply };
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
      const SYS = `Sos experto en prompt engineering para DALL-E 3, especializado en crear imágenes de marca consistentes para RhinosApp.

IDENTIDAD VISUAL DE RHINOSAPP (SIEMPRE aplicar):
- Fondo: negro azulado muy oscuro, casi negro (#0d1117)
- Acento principal: turquesa/cyan brillante y luminoso (#00e5cc), con efecto glow/neon
- Acento secundario: verde (#22c55e) solo para CTAs
- Estilo: cyberpunk industrial minimalista, tech premium, futurista pero sobrio
- Elementos de marca: circuitos electrónicos, hexágonos geométricos, líneas de datos, rinoceronte mecánico/robótico
- Iluminación: dramática, con luz de borde cyan sobre fondo oscuro, efectos de neón suaves
- Composición: minimalista, mucho espacio negativo, un elemento central dominante
- NUNCA incluir texto, letras, palabras o números en la imagen
- Calidad: ultra-detailed, photorealistic 3D render o cinematic digital art`;

      const pr = `Generá un prompt en inglés para DALL-E 3 para una imagen de marketing de RhinosApp en Instagram.

TEMA DEL POST: ${modulo}
ÁNGULO: ${angulo || 'concepto general del módulo'}
FORMATO: ${formato}
TONO: ${tono}

El prompt debe:
1. Empezar SIEMPRE con: "Dark cinematic digital art, ultra-detailed 3D render, deep dark navy-black background (#0d1117), glowing cyan/teal neon accents (#00e5cc),"
2. Incluir elementos visuales que representen el tema del módulo de forma abstracta o conceptual (ej: para stock → cajas/envases flotantes con datos; para cobranzas → monedas/flujos de dinero digitalizados)
3. Incluir elementos de marca: circuitos electrónicos, estructuras hexagonales, partículas de datos
4. Especificar iluminación: rim lighting en cyan, profundidad de campo cinematográfica
5. Terminar con: "no text, no letters, no words, minimalist composition, professional B2B marketing visual"
6. Máximo 180 palabras

Respondé SOLO con el prompt en inglés, sin explicaciones ni comillas.`;
      const imagePromptText = await anthropicFetch([{ role: 'user', content: pr }], SYS);
      result = { prompt: imagePromptText };
    }

    else if (action === 'generate_image') {
      const { prompt } = body;
      const OPENAI_KEY = process.env.OPENAI_API_KEY;
      const payload = JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard'
      });
      const imgData = await new Promise((resolve, reject) => {
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
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw.slice(0,200))); } });
        });
        req.on('error', reject); req.write(payload); req.end();
      });
      if (imgData.error) throw new Error(imgData.error.message);
      result = { url: imgData.data?.[0]?.url };
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
      let rawEmail = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n`;
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

    else if (action === 'generate_image') {
      const { prompt } = body;
      const OPENAI_KEY = process.env.OPENAI_API_KEY;
      if (!OPENAI_KEY) throw new Error('Missing OPENAI_API_KEY');
      const payload = JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard'
      });
      const imgData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.openai.com', path: '/v1/images/generations', method: 'POST',
          headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
          let raw = ''; res.on('data', c => raw += c);
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw.slice(0,200))); } });
        });
        req.on('error', reject); req.write(payload); req.end();
      });
      if (imgData.error) throw new Error(imgData.error.message);
      result = { url: imgData.data?.[0]?.url, revised_prompt: imgData.data?.[0]?.revised_prompt };
    }

    else if (action === 'generate_image_prompt') {
      const { modulo, angulo, formato, tono } = body;
      const SYSTEM = `Sos experto en crear prompts para DALL-E 3 para contenido de redes sociales de RhinosApp.
RhinosApp: CRM para distribuidoras de alimentos en Argentina. Dark theme, cyan #00e5cc, verde #22c55e.
Creás prompts en inglés, muy detallados, optimizados para DALL-E 3.`;
      const prompt = `Creá un prompt en inglés para DALL-E 3 para una imagen de Instagram de RhinosApp:
MÓDULO: ${modulo}
ÁNGULO: ${angulo||'libre'}
FORMATO: ${formato}
TONO: ${tono}

El prompt debe:
- Estar en inglés
- Especificar estilo visual: dark background #0d1117, cyan accents #00e5cc, professional tech aesthetic
- Ser específico sobre la composición y elementos visuales
- Máximo 200 palabras
- NO incluir texto/letras en la imagen (DALL-E no lo hace bien)
- Orientado a post cuadrado de Instagram

Devolvé SOLO el prompt, sin explicaciones.`;
      const reply = await anthropicFetch([{ role: 'user', content: prompt }], SYSTEM);
      result = { prompt: reply };
    }

    else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    return res.status(200).json(result);
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
