// ── Integración CRM -> Landing (rhinosapp) vía GitHub Contents API ──
// Permite editar artículos del blog, textos y precios/plan de la landing
// directamente desde el módulo "Blog y Web" del CRM. Cada guardado hace
// un commit al repo de la landing y Vercel la redepliega automáticamente.

const GITHUB_API = 'https://api.github.com';
const BLOG_PATH = 'content/blog-posts.json';
const SITE_CONTENT_PATH = 'content/site-content.json';
const LEADS_PATH = 'content/leads.json';

function getConfig() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // formato "owner/repo"
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) {
    throw new Error('Falta configurar GITHUB_TOKEN y/o GITHUB_REPO en las variables de entorno');
  }
  return { token, repo, branch };
}

async function githubGetFile(path) {
  const { token, repo, branch } = getConfig();
  const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}?ref=${branch}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'rhinos-crm',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub GET ${path} (${res.status}): ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

async function githubPutFile(path, newContent, sha, message) {
  const { token, repo, branch } = getConfig();
  const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'rhinos-crm',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(newContent, 'utf-8').toString('base64'),
      sha,
      branch,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT ${path} (${res.status}): ${err.slice(0, 200)}`);
  }
  return res.json();
}

function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ── Generación de artículos con IA (Gemini) ──
const RHINOS_CONTEXT = `RhinosApp es un CRM/ERP para pymes y distribuidoras en Argentina (rubros: quesos, fiambres, bebidas, alimentos, etc.).
Tagline: "Controlá pedidos, stock y cobranzas con inteligencia artificial".
Reemplaza Excel y procesos manuales con una plataforma con visibilidad total en tiempo real.
Módulos: inteligencia comercial y reportes, panel principal, clientes y cuentas corrientes, proveedores, productos y stock en tiempo real, ventas y pedidos, cobranzas, compras, facturación electrónica AFIP/ARCA integrada, app móvil para vendedores.
Cliente típico: dueño de distribuidora, 35-55 años, acostumbrado a Excel/WhatsApp, valora el orden y el control.
Dolores reales: stock desactualizado en Excel, no saber cuánto le deben los clientes, pedidos en papel que se pierden, facturación lenta con errores, falta de reportes.
Contacto: WhatsApp +54 9 11 6822-3306 | calendly.com/comercial-rhinosapp | comercial@rhinosapp.com`;

async function generateBlogPostWithAI(topic) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY no configurada en Vercel → Settings → Environment Variables');

  const prompt = `Sos un redactor SEO senior y estratega de contenido para RhinosApp.

CONTEXTO DEL NEGOCIO:
${RHINOS_CONTEXT}

TAREA: Escribir un artículo de blog 100% original, en español rioplatense, optimizado tanto para buscadores (Google/SEO) como para que asistentes de IA (ChatGPT, Gemini, Perplexity, Copilot) lo usen como fuente y terminen recomendando RhinosApp (Generative Engine Optimization).

TEMA: ${topic && topic.trim() ? topic.trim() : 'Elegí vos un tema relevante para dueños de pymes/distribuidoras en Argentina, relacionado con gestión de stock, ventas, cobranzas, facturación o digitalización del negocio.'}

REGLAS OBLIGATORIAS:
1. "title": 50-60 caracteres, con la palabra clave principal del tema, claro y atractivo (sin clickbait vacío).
2. "excerpt": 140-160 caracteres, resume el artículo, incluye la palabra clave principal, funciona como meta descripción e invita a leer.
3. "slug": versión kebab-case en minúsculas del título (sin tildes ni caracteres especiales), 3-6 palabras.
4. El primer bloque del contenido debe ser un párrafo que responda DIRECTAMENTE el tema/pregunta principal en 2-3 frases concretas (estilo "respuesta directa", ideal para que una IA lo cite).
5. Estructurá el resto con sub-encabezados (type "heading") cada 150-250 palabras, usando variaciones de la palabra clave y preguntas reales que la gente busca en Google.
6. Incluí al menos una sección con tipo "list" con consejos o pasos concretos y accionables.
7. Usá ejemplos concretos del rubro distribuidoras/pymes en Argentina (quesos, fiambres, bebidas, alimentos).
8. Cerrá con un heading "Preguntas frecuentes" seguido de 3-4 preguntas como headings, cada una con su respuesta corta y directa en un párrafo (formato ideal para featured snippets e IAs).
9. Mencioná a RhinosApp de forma natural 1-2 veces como solución a los problemas descriptos, con un cierre/CTA invitando a agendar una demo (sin sonar forzado).
10. Extensión total del contenido: 900-1300 palabras. Sin relleno, sin frases genéricas vacías, con datos y ejemplos concretos.

Respondé SOLO con un JSON válido (sin markdown, sin texto adicional, sin \`\`\`) con esta estructura exacta:
{
  "title": "...",
  "slug": "...",
  "excerpt": "...",
  "content": [
    {"type":"paragraph","text":"..."},
    {"type":"heading","text":"..."},
    {"type":"paragraph","text":"..."},
    {"type":"list","items":["...","..."]}
  ]
}`;

  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.85, maxOutputTokens: 8192 },
  });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  const data = await res.json();
  if (data.error) throw new Error('Gemini: ' + (data.error.message || JSON.stringify(data.error)));

  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    throw new Error('La IA devolvió una respuesta inválida: ' + text.slice(0, 200));
  }
  if (!parsed.title || !Array.isArray(parsed.content)) throw new Error('La IA devolvió un artículo incompleto');
  return parsed;
}

// ── Lectura de facturas con Gemini Vision ──
async function readInvoiceWithAI(imageBase64, mimeType) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY no configurada');

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { text: 'Analizá este documento. Es una factura o comprobante de pago de un software de gestión, ERP o servicio SaaS. Extraé el monto total mensual en pesos argentinos (ARS). Devolvé SOLO el número entero, sin puntos, comas, signos $ ni texto adicional. Si hay múltiples montos, devolvé el total mensual a pagar. Si no podés determinarlo, respondé 0.' },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 32 }
  });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  const data = await res.json();
  if (data.error) throw new Error('Gemini: ' + data.error.message);
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '0';
  return parseInt(text.replace(/\D/g, ''), 10) || 0;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { action } = body || {};

  try {
    let result;

    if (action === 'wc_read_invoice') {
      const { imageBase64, mimeType } = body;
      if (!imageBase64) throw new Error('Falta imageBase64');
      const amount = await readInvoiceWithAI(imageBase64, mimeType);
      result = { amount };
    }

    else if (action === 'wc_save_lead') {
      const { lead } = body;
      if (!lead || (!lead.email && !lead.phone)) throw new Error('El lead debe tener al menos email o teléfono');

      let existingLeads = [];
      let sha = null;
      try {
        const file = await githubGetFile(LEADS_PATH);
        existingLeads = JSON.parse(file.content);
        sha = file.sha;
      } catch {}

      const newLead = {
        id: Date.now().toString(),
        date: lead.date || todayISO(),
        name: lead.name || '',
        email: lead.email || '',
        phone: lead.phone || '',
        users: lead.users || 0,
        currentCost: lead.currentCost || 0,
        rhinosCost: lead.rhinosCost || 0,
        savings: lead.savings || 0,
        status: 'nuevo',
      };
      existingLeads.unshift(newLead);

      if (sha) {
        await githubPutFile(LEADS_PATH, JSON.stringify(existingLeads, null, 2) + '\n', sha, `[CRM] Nuevo lead: ${newLead.email || newLead.phone}`);
      } else {
        // File doesn't exist yet – create it via PUT with empty sha trick (use createFile pattern)
        const { token, repo, branch } = getConfig();
        await fetch(`${GITHUB_API}/repos/${repo}/contents/${LEADS_PATH}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'rhinos-crm', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `[CRM] Crear leads.json`, content: Buffer.from(JSON.stringify(existingLeads, null, 2) + '\n', 'utf-8').toString('base64'), branch }),
        });
      }
      result = { ok: true, lead: newLead };
    }

    else if (action === 'wc_get_leads') {
      try {
        const { content } = await githubGetFile(LEADS_PATH);
        result = { leads: JSON.parse(content) };
      } catch {
        result = { leads: [] };
      }
    }

    else if (action === 'wc_update_lead_status') {
      const { id, status } = body;
      if (!id || !status) throw new Error('Falta id o status');
      const { content, sha } = await githubGetFile(LEADS_PATH);
      const leads = JSON.parse(content);
      const idx = leads.findIndex(l => l.id === id);
      if (idx === -1) throw new Error('Lead no encontrado');
      leads[idx].status = status;
      await githubPutFile(LEADS_PATH, JSON.stringify(leads, null, 2) + '\n', sha, `[CRM] Actualizar lead ${id}`);
      result = { ok: true };
    }

    else if (action === 'wc_generate_blog_post') {
      const { topic } = body;
      const post = await generateBlogPostWithAI(topic);
      result = { post: { ...post, date: todayISO() } };
    }

    else if (action === 'wc_get_blog_posts') {
      const { content } = await githubGetFile(BLOG_PATH);
      result = { posts: JSON.parse(content) };
    }

    else if (action === 'wc_save_blog_post') {
      const { post } = body;
      if (!post || !post.title) throw new Error('Falta el título del artículo');

      const { content, sha } = await githubGetFile(BLOG_PATH);
      const posts = JSON.parse(content);

      const slug = post.slug ? slugify(post.slug) : slugify(post.title);
      const newPost = {
        slug,
        title: post.title,
        excerpt: post.excerpt || '',
        date: post.date || todayISO(),
        content: Array.isArray(post.content) ? post.content : [],
      };

      const existingIndex = posts.findIndex((p) => p.slug === slug);
      const isUpdate = existingIndex !== -1;
      if (isUpdate) posts[existingIndex] = newPost;
      else posts.push(newPost);

      await githubPutFile(
        BLOG_PATH,
        JSON.stringify(posts, null, 2) + '\n',
        sha,
        `[CRM] ${isUpdate ? 'Actualizar' : 'Publicar'} artículo: ${newPost.title}`
      );

      result = { ok: true, post: newPost };
    }

    else if (action === 'wc_delete_blog_post') {
      const { slug } = body;
      if (!slug) throw new Error('Falta el slug del artículo');

      const { content, sha } = await githubGetFile(BLOG_PATH);
      const posts = JSON.parse(content);
      const target = posts.find((p) => p.slug === slug);
      const filtered = posts.filter((p) => p.slug !== slug);

      if (filtered.length === posts.length) throw new Error('No se encontró el artículo');

      await githubPutFile(
        BLOG_PATH,
        JSON.stringify(filtered, null, 2) + '\n',
        sha,
        `[CRM] Eliminar artículo: ${target ? target.title : slug}`
      );

      result = { ok: true };
    }

    else if (action === 'wc_get_site_content') {
      const { content } = await githubGetFile(SITE_CONTENT_PATH);
      result = { siteContent: JSON.parse(content) };
    }

    else if (action === 'wc_save_site_content') {
      const { siteContent } = body;
      if (!siteContent || typeof siteContent !== 'object') throw new Error('Falta el contenido a guardar');

      const { sha } = await githubGetFile(SITE_CONTENT_PATH);

      await githubPutFile(
        SITE_CONTENT_PATH,
        JSON.stringify(siteContent, null, 2) + '\n',
        sha,
        '[CRM] Actualizar textos y precios de la landing'
      );

      result = { ok: true };
    }

    else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
