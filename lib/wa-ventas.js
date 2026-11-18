'use strict';
// Bot de ventas de RhinosApp por WhatsApp (API oficial de Meta).
// Atiende a distribuidoras interesadas: explica el producto, pasa precios,
// califica y avisa al equipo. Las conversaciones quedan en Supabase y cada
// número entra como lead al pipeline (rhinos_leads).
//
// Variables en Vercel:
//   WA_VENTAS_TOKEN         token permanente del usuario de sistema (Meta)
//   WA_VENTAS_PHONE_ID      Phone number ID del número de ventas
//   WA_VENTAS_VERIFY_TOKEN  texto libre para verificar el webhook
//   SUPABASE_SERVICE_KEY    clave de servicio (las conversaciones no son públicas)
//   ANTHROPIC_API_KEY       ya existe
//   OPENAI_API_KEY          opcional: para entender audios
// Configuración editable (rhinos_config):
//   wa_ventas_activo        "false" apaga el bot (los mensajes se guardan igual)
//   wa_ventas_info_extra    texto que se suma a lo que sabe el bot
//   wa_recipients           a quién avisar por WhatsApp (CallMeBot, ya existe)

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';
const GRAPH = 'https://graph.facebook.com/v21.0';
const MODEL = () => process.env.WA_VENTAS_MODEL || 'claude-haiku-4-5-20251001';
const HISTORY = 30;
// Espera antes de responder: si la persona manda varios mensajes seguidos,
// se contesta una sola vez a todos.
const DEBOUNCE_MS = () => Number(process.env.WA_VENTAS_DEBOUNCE_MS ?? 3500);
const CLOSED_STATUS = ['perdido', 'imposible'];
const PAUSE_TAG = 'bot-pausado';

// ── Supabase ─────────────────────────────────────────────────────────────────
function sbKey() {
  return process.env.SUPABASE_SERVICE_KEY || SB_ANON;
}

async function sb(method, path, body, prefer) {
  const key = sbKey();
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SB ${method} ${path.split('?')[0]}: ${r.status} ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function getConfig() {
  const rows = await sb('GET', 'rhinos_config?key=in.(wa_ventas_activo,wa_ventas_info_extra,wa_recipients)&select=key,value').catch(() => []);
  const cfg = {};
  for (const { key, value } of rows || []) cfg[key] = typeof value === 'string' ? value : JSON.stringify(value);
  return cfg;
}

function parseJsonish(v) {
  if (!v) return null;
  try {
    let out = JSON.parse(v);
    if (typeof out === 'string') out = JSON.parse(out);
    return out;
  } catch { return null; }
}

async function getPriceTiers() {
  const rows = await sb('GET', 'rhinos_pres_tiers?id=eq.default&select=data').catch(() => []);
  const data = rows?.[0]?.data;
  return Array.isArray(data) ? data.filter((t) => t && t.desc) : [];
}

// ── WhatsApp (Meta) ──────────────────────────────────────────────────────────
async function graph(path, body) {
  const r = await fetch(`${GRAPH}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.WA_VENTAS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Meta ${path}: ${j.error?.message || r.status}`);
  return j;
}

async function sendText(to, text) {
  const j = await graph(`${process.env.WA_VENTAS_PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text.slice(0, 4000), preview_url: true },
  });
  return j.messages?.[0]?.id || `bot-${Date.now()}`;
}

// Marca leído y muestra "escribiendo…" mientras se arma la respuesta.
function markReadTyping(messageId) {
  return graph(`${process.env.WA_VENTAS_PHONE_ID}/messages`, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  }).catch(() => {});
}

async function transcribeAudio(mediaId) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const meta = await graph(mediaId);
    const file = await fetch(meta.url, { headers: { Authorization: `Bearer ${process.env.WA_VENTAS_TOKEN}` } });
    if (!file.ok) return null;
    const form = new FormData();
    form.append('file', new Blob([await file.arrayBuffer()], { type: meta.mime_type || 'audio/ogg' }), 'audio.ogg');
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('language', 'es');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    return j.text?.trim() || null;
  } catch (e) {
    console.warn('[wa-ventas] audio:', e.message);
    return null;
  }
}

/** Texto del mensaje entrante (los audios se transcriben). */
async function messageText(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body?.trim() || '';
    case 'button': return msg.button?.text || '';
    case 'interactive':
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    case 'audio': {
      const text = await transcribeAudio(msg.audio?.id);
      return text ? `[audio] ${text}` : '[mandó un audio que no se pudo escuchar]';
    }
    case 'image': return `[mandó una imagen]${msg.image?.caption ? ` ${msg.image.caption}` : ''}`;
    case 'document': return `[mandó un archivo]${msg.document?.caption ? ` ${msg.document.caption}` : ''}`;
    default: return `[mandó un mensaje de tipo ${msg.type}]`;
  }
}

// ── Leads del CRM ────────────────────────────────────────────────────────────
// Últimos 7 dígitos: iguala "+54 9 11 5555-6666", "011 15 5555-6666" y el
// formato de WhatsApp (5491155556666), que difieren en prefijos.
function phoneTail(phone) {
  return String(phone).replace(/\D/g, '').slice(-7);
}

async function findLead(phone) {
  const tail = phoneTail(phone);
  if (tail.length < 7) return null;
  // Los teléfonos se cargan con espacios o guiones: se busca por los últimos
  // 4 dígitos (casi siempre juntos) y se compara normalizado.
  const rows = await sb('GET', `rhinos_leads?phone=ilike.*${tail.slice(-4)}*&select=id,name,status,tags,phone&order=created_at.desc&limit=100`).catch(() => []);
  return (rows || []).find((l) => phoneTail(l.phone) === tail) || null;
}

function hasTag(tags, tag) {
  return String(tags || '').toLowerCase().split(/[,;\s]+/).includes(tag);
}

function addTag(tags, tag) {
  return hasTag(tags, tag) ? tags : [tags, tag].filter(Boolean).join(', ');
}

async function logInteraction(leadId, note) {
  if (!leadId) return;
  await sb('POST', 'rhinos_lead_interactions', [{ lead_id: leadId, type: 'whatsapp', note }], 'return=minimal')
    .catch((e) => console.warn('[wa-ventas] interacción:', e.message));
}

async function createLead(phone, name, firstText, origen) {
  const notes = ['Entró por el bot de ventas de WhatsApp.', origen ? `Anuncio: ${origen}` : '']
    .filter(Boolean).join('\n');
  const rows = await sb('POST', 'rhinos_leads', [{
    name: name || `WhatsApp ${phone.slice(-4)}`,
    phone: `+${phone}`,
    source: 'WhatsApp',
    status: 'nuevo',
    tags: 'bot-whatsapp',
    notes,
    updated_at: new Date().toISOString(),
  }]);
  const lead = rows?.[0] || null;
  if (lead) await logInteraction(lead.id, `Primer mensaje por WhatsApp: "${firstText.slice(0, 300)}"`);
  return lead;
}

// ── Avisos al equipo ─────────────────────────────────────────────────────────
async function notifyTeam(cfg, title, body) {
  const jobs = [
    fetch('https://rhinos-crm.vercel.app/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send', title, body, tag: 'wa-ventas' }),
    }).catch(() => {}),
  ];
  const recipients = parseJsonish(cfg.wa_recipients);
  for (const r of Array.isArray(recipients) ? recipients : []) {
    if (!(r?.phone && r?.apikey)) continue;
    const text = `*${title}*\n${body}`;
    jobs.push(fetch(`https://api.callmebot.com/whatsapp.php?phone=${r.phone}&text=${encodeURIComponent(text)}&apikey=${r.apikey}`).catch(() => {}));
  }
  await Promise.all(jobs);
}

function leadSummary(phone, datos, resumen) {
  const d = datos || {};
  const who = [d.nombre, d.empresa].filter(Boolean).join(' — ') || 'Sin nombre';
  const lines = [
    `👤 ${who}`,
    [d.rubro, d.zona].filter(Boolean).length ? `📍 ${[d.rubro, d.zona].filter(Boolean).join(' · ')}` : '',
    d.vendedores ? `🧑‍💼 Vendedores: ${d.vendedores}` : '',
    d.sistema_actual ? `🗂 Hoy usa: ${d.sistema_actual}` : '',
    d.dolor_principal ? `🔥 Dolor: ${d.dolor_principal}` : '',
    d.temperatura ? `🌡 ${d.temperatura}` : '',
    resumen ? `💬 ${resumen}` : '',
    `📱 https://wa.me/${phone}`,
  ];
  return lines.filter(Boolean).join('\n');
}

// ── IA ───────────────────────────────────────────────────────────────────────
const ARS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

function priceText(tiers) {
  if (!tiers.length) {
    return 'Todavía no tenés los precios cargados: si preguntan, decí que se los pasa el equipo y marcá quiere_humano.';
  }
  return tiers
    .map((t) => `- ${t.desc}: ${ARS.format(Number(t.price) || 0)}${t.note ? ` (${t.note})` : ''}`)
    .join('\n');
}

function systemPrompt({ tiers, extra, datos, calificado, isNew }) {
  return `Sos el asistente comercial de RhinosApp por WhatsApp. Hablás en español rioplatense (voseo), cálido, directo y breve, como un buen vendedor humano. Nunca corporativo.

QUÉ ES RHINOSAPP
- Sistema de gestión (ERP + CRM) en la nube para distribuidoras y mayoristas de alimentos y bebidas (quesos, fiambres, almacén, bebidas) de Argentina.
- Reemplaza el Excel, el papel y los grupos de WhatsApp por una sola plataforma con todo en tiempo real.
- Módulos: pedidos y ventas (preventa), stock en tiempo real, clientes y cuentas corrientes, cobranzas, compras y proveedores, cuentas por pagar, facturación electrónica ARCA/AFIP integrada, panel con indicadores, inteligencia comercial y reportes automáticos.
- App móvil para los vendedores en la calle.
- Incluye migración gratis desde Excel/papel, capacitación del equipo y soporte por WhatsApp.
- Dolores típicos que resuelve: stock desactualizado, no saber cuánto deben los clientes, pedidos en papel que se pierden, facturar a mano lleva horas, no tener reportes.

PRECIOS (por mes, en pesos, MÁS IVA)
${priceText(tiers)}
- Siempre aclará que el precio es mensual y más IVA.
- Pasá el precio cuando lo pidan o cuando ya sepas cuántos usuarios necesita.
- Plan personalizado (más de 30 usuarios, usuarios ilimitados o necesidades especiales): no tiene precio de lista, lo arma un comercial. Decí eso y marcá quiere_humano.
- No inventes descuentos, promociones ni precios que no estén acá.
${extra ? `\nINFO EXTRA DEL EQUIPO\n${extra}\n` : ''}
TU OBJETIVO
1. Entender su negocio con preguntas cortas, una por mensaje: nombre, empresa, qué distribuye y dónde, cuántos vendedores/usuarios, cómo se manejan hoy y qué les duele.
2. Mostrar cómo RhinosApp resuelve lo que te cuenta (con ejemplos concretos de su rubro).
3. Calificarlo. Está calificado cuando: es una distribuidora/mayorista (o negocio de venta B2B parecido), habla alguien que decide o influye, y muestra interés real (pide precio, demo, cómo empezar o cuenta un problema que RhinosApp resuelve).
4. Cuando quede calificado: decile que alguien del equipo lo va a contactar a la brevedad. Después seguí respondiendo y contándole cosas útiles de RhinosApp de a poco, sin insistir ni mandar mensajes largos.

REGLAS
- Mensajes cortos para WhatsApp: 1 a 4 líneas, como mucho una pregunta por mensaje. Emojis con moderación (🦏 a veces).
- No inventes funciones, integraciones ni plazos. Si no sabés algo, decí que lo confirma el equipo.
- Si pide hablar con una persona, marcá quiere_humano y decile que ya le avisás al equipo.
- Si no le interesa o pide que no le escriban, despedite con amabilidad y marcá no_interesado.
- Si es cliente actual y necesita soporte, marcá quiere_humano y decile que le avisás al equipo de soporte.
- Si escribe algo que no tiene que ver (spam, otro rubro), respondé cortito y amable.
- Nunca pidas datos de tarjeta ni contraseñas.

ESTADO DE ESTA CONVERSACIÓN
- ${isNew ? 'Es el primer mensaje: presentate en una línea.' : 'Ya vienen conversando: no te vuelvas a presentar.'}
- Lo que ya sabés: ${JSON.stringify(datos || {})}
- ${calificado ? 'Ya está calificado y se le avisó al equipo: no lo repitas en cada mensaje.' : 'Todavía no está calificado.'}

Respondé SIEMPRE usando la herramienta "responder".`;
}

const RESPOND_TOOL = {
  name: 'responder',
  description: 'Mensaje para mandarle por WhatsApp y lo que sabés del interesado.',
  input_schema: {
    type: 'object',
    properties: {
      mensaje: { type: 'string', description: 'Lo que se le manda por WhatsApp.' },
      datos: {
        type: 'object',
        description: 'Todo lo que sabés hasta ahora (repetí lo anterior y sumá lo nuevo).',
        properties: {
          nombre: { type: 'string' },
          empresa: { type: 'string' },
          rubro: { type: 'string' },
          zona: { type: 'string' },
          vendedores: { type: 'string' },
          sistema_actual: { type: 'string' },
          dolor_principal: { type: 'string' },
          email: { type: 'string' },
          es_decisor: { type: 'boolean' },
        },
      },
      calificado: { type: 'boolean' },
      quiere_humano: { type: 'boolean' },
      no_interesado: { type: 'boolean' },
      temperatura: { type: 'string', enum: ['frio', 'tibio', 'caliente'] },
      resumen: { type: 'string', description: 'Resumen de 1 a 2 líneas para el equipo de ventas.' },
    },
    required: ['mensaje', 'datos', 'calificado', 'temperatura', 'resumen'],
  },
};

function toClaudeMessages(history) {
  const out = [];
  for (const m of history) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = m.role === 'equipo' ? `[Mensaje del equipo] ${m.texto}` : m.texto;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function askClaude(system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL(),
      max_tokens: 900,
      system,
      messages,
      tools: [RESPOND_TOOL],
      tool_choice: { type: 'tool', name: 'responder' },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude: ${j.error?.message || r.status}`);
  const out = (j.content || []).find((c) => c.type === 'tool_use')?.input;
  if (!out?.mensaje) throw new Error('Claude no devolvió mensaje');
  return out;
}

// ── Flujo principal ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function saveMessage(id, phone, role, texto) {
  // on_conflict + ignore-duplicates: si Meta reintenta, no se procesa dos veces.
  const rows = await sb('POST', 'rhinos_wa_ventas_msgs?on_conflict=id', [{ id, phone, role, texto }],
    'resolution=ignore-duplicates,return=representation');
  return Array.isArray(rows) && rows.length > 0;
}

async function latestUserMessageId(phone) {
  const rows = await sb('GET', `rhinos_wa_ventas_msgs?phone=eq.${phone}&role=eq.user&select=id&order=created_at.desc&limit=1`);
  return rows?.[0]?.id || null;
}

async function loadHistory(phone) {
  const rows = await sb('GET', `rhinos_wa_ventas_msgs?phone=eq.${phone}&select=role,texto,created_at&order=created_at.desc&limit=${HISTORY}`);
  return (rows || []).reverse();
}

async function loadConversation(phone) {
  const rows = await sb('GET', `rhinos_wa_ventas?phone=eq.${phone}&select=*`);
  return rows?.[0] || null;
}

async function saveConversation(row) {
  await sb('POST', 'rhinos_wa_ventas?on_conflict=phone', [{ ...row, updated_at: new Date().toISOString() }],
    'resolution=merge-duplicates,return=minimal');
}

function adOrigin(msg) {
  const ref = msg.referral;
  if (!ref) return null;
  return [ref.headline, ref.source_url].filter(Boolean).join(' — ') || `anuncio ${ref.source_id || ''}`.trim();
}

/** Si el bot no debe responder, devuelve el motivo. */
function silenceReason(cfg, lead) {
  if (String(cfg.wa_ventas_activo).replace(/"/g, '') === 'false') return 'bot apagado';
  if (lead && hasTag(lead.tags, PAUSE_TAG)) return 'bot pausado en este lead';
  if (lead && CLOSED_STATUS.includes(lead.status)) return `lead ${lead.status}`;
  return null;
}

async function updateLeadAfterReply(conv, lead, ai, justQualified) {
  if (!lead) return;
  const patch = { updated_at: new Date().toISOString() };
  const d = ai.datos || {};
  if (d.empresa) patch.company = d.empresa;
  if (d.email) patch.email = d.email;
  if (d.nombre && /^WhatsApp \d{4}$/.test(lead.name || '')) patch.name = d.nombre;
  if (justQualified) {
    patch.tags = addTag(lead.tags, 'calificado-bot');
    patch.next_followup = new Date().toISOString().slice(0, 10);
  }
  if (ai.no_interesado) patch.tags = addTag(patch.tags || lead.tags, 'no-interesado');
  await sb('PATCH', `rhinos_leads?id=eq.${lead.id}`, patch, 'return=minimal')
    .catch((e) => console.warn('[wa-ventas] lead:', e.message));
}

/** Procesa un mensaje entrante de WhatsApp. */
async function handleIncoming(msg, contact) {
  const phone = msg.from;
  const name = contact?.profile?.name || null;
  const texto = await messageText(msg);
  if (!texto) return { skipped: 'vacío' };

  const fresh = await saveMessage(msg.id, phone, 'user', texto);
  if (!fresh) return { skipped: 'duplicado' };
  markReadTyping(msg.id);

  const [cfg, existing] = await Promise.all([getConfig(), loadConversation(phone)]);
  const origen = adOrigin(msg);
  let lead = await findLead(phone);
  if (!lead) lead = await createLead(phone, name, texto, origen).catch((e) => {
    console.warn('[wa-ventas] crear lead:', e.message);
    return null;
  });
  const conv = existing || { phone, nombre: name, datos: {}, calificado: false, origen };
  conv.lead_id = lead?.id ? String(lead.id) : conv.lead_id || null;
  conv.nombre = conv.nombre || name;

  const silent = silenceReason(cfg, lead);
  if (silent) {
    await saveConversation(conv);
    return { skipped: silent };
  }

  // Varios mensajes seguidos: contesta solo la última invocación.
  await sleep(DEBOUNCE_MS());
  if ((await latestUserMessageId(phone)) !== msg.id) {
    await saveConversation(conv);
    return { skipped: 'llegó otro mensaje' };
  }

  const [history, tiers] = await Promise.all([loadHistory(phone), getPriceTiers()]);
  const ai = await askClaude(
    systemPrompt({ tiers, extra: cfg.wa_ventas_info_extra?.replace(/^"|"$/g, ''), datos: conv.datos, calificado: conv.calificado, isNew: !existing }),
    toClaudeMessages(history),
  );

  const sentId = await sendText(phone, ai.mensaje);
  await saveMessage(sentId, phone, 'bot', ai.mensaje);

  const wantsHuman = Boolean(ai.quiere_humano);
  const justQualified = (ai.calificado || wantsHuman) && !conv.avisado_at;
  conv.datos = { ...(conv.datos || {}), ...(ai.datos || {}), temperatura: ai.temperatura };
  conv.calificado = conv.calificado || Boolean(ai.calificado);
  if (justQualified) conv.avisado_at = new Date().toISOString();
  await saveConversation(conv);
  await updateLeadAfterReply(conv, lead, ai, justQualified);

  if (justQualified) {
    const title = wantsHuman && !ai.calificado ? '🙋 Pide hablar con alguien (bot WhatsApp)' : '🦏 Lead calificado por el bot';
    const summary = leadSummary(phone, conv.datos, ai.resumen);
    await Promise.all([
      notifyTeam(cfg, title, summary),
      logInteraction(lead?.id, `${title}\n${summary}`),
    ]);
  }
  return { replied: true, calificado: conv.calificado, avisado: justQualified };
}

/** Recorre el payload del webhook y procesa cada mensaje. */
async function processWebhook(body) {
  const results = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (change.field !== 'messages' || !v.messages?.length) continue;
      const expected = process.env.WA_VENTAS_PHONE_ID;
      if (expected && v.metadata?.phone_number_id && v.metadata.phone_number_id !== expected) continue;
      for (const msg of v.messages) {
        const contact = (v.contacts || []).find((c) => c.wa_id === msg.from) || v.contacts?.[0];
        try {
          results.push(await handleIncoming(msg, contact));
        } catch (e) {
          console.error('[wa-ventas]', e.message);
          results.push({ error: e.message });
        }
      }
    }
  }
  return results;
}

function runInBackground(promise) {
  try {
    const { waitUntil } = require('@vercel/functions');
    waitUntil(promise);
    return true;
  } catch {
    return false;
  }
}

/** Handler HTTP: GET verifica el webhook, POST recibe mensajes. */
async function handle(req, res) {
  if (req.method === 'GET') {
    const q = req.query || {};
    const expected = process.env.WA_VENTAS_VERIFY_TOKEN;
    if (q['hub.mode'] === 'subscribe' && expected && q['hub.verify_token'] === expected) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).json({ error: 'Token de verificación incorrecto' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!(process.env.WA_VENTAS_TOKEN && process.env.WA_VENTAS_PHONE_ID)) {
    console.error('[wa-ventas] faltan WA_VENTAS_TOKEN / WA_VENTAS_PHONE_ID');
    return res.status(200).json({ ok: false, error: 'bot sin configurar' });
  }
  // Meta espera un 200 rápido: se responde y se sigue trabajando.
  const work = processWebhook(req.body).catch((e) => console.error('[wa-ventas]', e.message));
  if (runInBackground(work)) return res.status(200).json({ ok: true });
  const results = await work;
  return res.status(200).json({ ok: true, results });
}

module.exports = {
  handle,
  processWebhook,
  // para tests
  _internal: { systemPrompt, toClaudeMessages, leadSummary, silenceReason, phoneTail, addTag, hasTag, priceText },
};
