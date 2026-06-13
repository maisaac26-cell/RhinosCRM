// ── Integración CRM -> Landing (rhinosapp) vía GitHub Contents API ──
// Permite editar artículos del blog, textos y precios/plan de la landing
// directamente desde el módulo "Blog y Web" del CRM. Cada guardado hace
// un commit al repo de la landing y Vercel la redepliega automáticamente.

const GITHUB_API = 'https://api.github.com';
const BLOG_PATH = 'content/blog-posts.json';
const SITE_CONTENT_PATH = 'content/site-content.json';

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

    if (action === 'wc_get_blog_posts') {
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
