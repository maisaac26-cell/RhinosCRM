'use strict';
// node --test test/  — simula Supabase, Meta y Claude con un fetch falso.
const test = require('node:test');
const assert = require('node:assert');

process.env.WA_VENTAS_TOKEN = 'tok';
process.env.WA_VENTAS_PHONE_ID = 'PHONE1';
process.env.WA_VENTAS_DEBOUNCE_MS = '0';
process.env.ANTHROPIC_API_KEY = 'k';

const bot = require('../lib/wa-ventas');

function world({ config = {}, leads = [], aiReplies = [] } = {}) {
  const db = {
    rhinos_config: Object.entries(config).map(([key, value]) => ({ key, value })),
    rhinos_leads: leads,
    rhinos_lead_interactions: [],
    rhinos_wa_ventas: [],
    rhinos_wa_ventas_msgs: [],
    rhinos_pres_tiers: [{ id: 'default', data: [{ desc: 'ERP 1 – 5 usuarios', price: 278600 }] }],
  };
  const sent = [];
  const notified = [];
  const prompts = [];
  let seq = 0;
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    if (u.hostname.endsWith('supabase.co')) {
      const table = u.pathname.replace('/rest/v1/', '');
      const rows = db[table];
      const filters = [...u.searchParams].filter(([k]) => !['select', 'order', 'limit', 'on_conflict'].includes(k));
      const match = (r) => filters.every(([k, v]) => {
        if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
        if (v.startsWith('in.')) return v.slice(4, -1).split(',').includes(String(r[k]));
        if (v.startsWith('ilike.')) return String(r[k] || '').includes(v.slice(6).replaceAll('*', ''));
        return true;
      });
      if (method === 'GET') {
        let out = rows.filter(match);
        if (u.searchParams.get('order')?.includes('desc')) out = [...out].reverse();
        const limit = Number(u.searchParams.get('limit') || 1000);
        return json(out.slice(0, limit));
      }
      if (method === 'POST') {
        const key = u.searchParams.get('on_conflict');
        const ignore = (opts.headers?.Prefer || '').includes('ignore-duplicates');
        const inserted = [];
        for (const row of body) {
          const existing = key && rows.find((r) => r[key] === row[key]);
          if (existing) { if (!ignore) Object.assign(existing, row); continue; }
          const r = { id: row.id ?? `id${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...row };
          rows.push(r); inserted.push(r);
        }
        return json(inserted, 201);
      }
      if (method === 'PATCH') {
        rows.filter(match).forEach((r) => Object.assign(r, body));
        return json(null, 204);
      }
    }
    if (u.hostname === 'graph.facebook.com') {
      if (body?.status === 'read') return json({ success: true });
      sent.push(body);
      return json({ messages: [{ id: `wamid.bot${++seq}` }] });
    }
    if (u.hostname === 'api.anthropic.com') {
      prompts.push(body);
      const next = aiReplies.shift() || { mensaje: 'ok', datos: {}, calificado: false, temperatura: 'tibio', resumen: '' };
      return json({ content: [{ type: 'tool_use', name: 'responder', input: next }] });
    }
    if (u.pathname === '/api/push' || u.hostname === 'api.callmebot.com') {
      notified.push(url);
      return json({ ok: true });
    }
    throw new Error(`fetch inesperado: ${url}`);
  };
  return { db, sent, notified, prompts };
}

function payload(from, text, id, extra = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'PHONE1' },
      contacts: [{ wa_id: from, profile: { name: 'Juan' } }],
      messages: [{ from, id, type: 'text', text: { body: text }, ...extra }],
    } }] }],
  };
}

test('primer mensaje: crea lead, responde y guarda la conversación', async () => {
  const w = world({ aiReplies: [{ mensaje: 'Hola Juan! Soy el asistente de RhinosApp 🦏 ¿Qué distribuís?', datos: { nombre: 'Juan' }, calificado: false, temperatura: 'tibio', resumen: '' }] });
  const [r] = await bot.processWebhook(payload('5491122334455', 'Hola, info', 'wamid.1', { referral: { headline: 'Dejá el Excel' } }));
  assert.deepStrictEqual(r, { replied: true, calificado: false, avisado: false, derivado: false });
  assert.strictEqual(w.db.rhinos_leads.length, 1);
  assert.match(w.db.rhinos_leads[0].notes, /Dejá el Excel/);
  assert.strictEqual(w.db.rhinos_leads[0].source, 'WhatsApp');
  assert.strictEqual(w.sent[0].to, '5491122334455');
  assert.strictEqual(w.db.rhinos_wa_ventas_msgs.length, 2);
  assert.match(w.prompts[0].system, /NO DES NÚMEROS/);
  assert.doesNotMatch(w.prompts[0].system, /\$\s?\d/);
  assert.match(w.prompts[0].system, /primer mensaje/);
  assert.strictEqual(w.notified.length, 1); // push "nuevo contacto", sin WhatsApp
  assert.match(w.notified[0], /api\/push/);
});

test('Meta reintenta el mismo mensaje: no responde dos veces', async () => {
  const w = world();
  await bot.processWebhook(payload('5491100000001', 'hola', 'wamid.dup'));
  const [r] = await bot.processWebhook(payload('5491100000001', 'hola', 'wamid.dup'));
  assert.deepStrictEqual(r, { skipped: 'duplicado' });
  assert.strictEqual(w.sent.length, 1);
});

test('al calificar avisa una sola vez y marca el lead', async () => {
  const q = { mensaje: 'Genial, alguien del equipo te contacta a la brevedad.', datos: { nombre: 'Ana', empresa: 'Lácteos Sur', rubro: 'quesos', vendedores: '4' }, calificado: true, temperatura: 'caliente', resumen: 'Distribuidora de quesos, 4 vendedores, quiere precio.' };
  const w = world({
    config: { wa_recipients: JSON.stringify([{ phone: '5491111', apikey: 'x' }]) },
    aiReplies: [q, { ...q, mensaje: 'Además tenés app para vendedores.' }],
  });
  const [r1] = await bot.processWebhook(payload('5491133334444', 'somos 4 vendedores, cuánto sale?', 'wamid.a'));
  const [r2] = await bot.processWebhook(payload('5491133334444', 'y tiene app?', 'wamid.b'));
  assert.strictEqual(r1.avisado, true);
  assert.strictEqual(r2.avisado, false);
  // push "nuevo contacto" + (push + WhatsApp del dueño al calificar); el 2.º mensaje no avisa
  assert.strictEqual(w.notified.length, 3);
  assert.ok(w.notified.some((u) => /callmebot/.test(u) && /Lácteos Sur/.test(decodeURIComponent(u))));
  assert.match(w.db.rhinos_leads[0].tags, /calificado-bot/);
  assert.strictEqual(w.db.rhinos_leads[0].company, 'Lácteos Sur');
  assert.match(w.prompts[1].system, /Ya está calificado/);
  assert.ok(w.db.rhinos_lead_interactions.some((i) => /calificado/.test(i.note)));
});

test('lead existente con bot-pausado: guarda y no responde', async () => {
  const w = world({ leads: [{ id: 'L1', name: 'Pepe', phone: '+54 9 11 5555-6666', status: 'contactado', tags: 'vip, bot-pausado' }] });
  const [r] = await bot.processWebhook(payload('5491155556666', 'hola?', 'wamid.p'));
  assert.deepStrictEqual(r, { skipped: 'bot pausado en este lead' });
  assert.strictEqual(w.sent.length, 0);
  assert.strictEqual(w.db.rhinos_leads.length, 1);
  assert.strictEqual(w.db.rhinos_wa_ventas[0].lead_id, 'L1');
});

test('bot apagado desde la configuración', async () => {
  const w = world({ config: { wa_ventas_activo: 'false' } });
  const [r] = await bot.processWebhook(payload('5491177778888', 'hola', 'wamid.off'));
  assert.deepStrictEqual(r, { skipped: 'bot apagado' });
  assert.strictEqual(w.sent.length, 0);
});

test('mensajes de otro número de Meta se ignoran', async () => {
  const w = world();
  const p = payload('5491100000009', 'hola', 'wamid.x');
  p.entry[0].changes[0].value.metadata.phone_number_id = 'OTRO';
  assert.deepStrictEqual(await bot.processWebhook(p), []);
  assert.strictEqual(w.sent.length, 0);
});

test('historial para Claude junta turnos seguidos y empieza por el usuario', () => {
  const out = bot._internal.toClaudeMessages([
    { role: 'bot', texto: 'x' },
    { role: 'user', texto: 'a' },
    { role: 'user', texto: 'b' },
    { role: 'equipo', texto: 'c' },
  ]);
  assert.deepStrictEqual(out, [
    { role: 'user', content: 'a\nb' },
    { role: 'assistant', content: '[Mensaje del equipo] c' },
  ]);
});

test('verificación del webhook', async () => {
  process.env.WA_VENTAS_VERIFY_TOKEN = 'secreto';
  let status; let sentBody;
  const res = { status(s) { status = s; return this; }, send(b) { sentBody = b; return this; }, json(b) { sentBody = b; return this; } };
  await bot.handle({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'secreto', 'hub.challenge': '42' } }, res);
  assert.strictEqual(status, 200);
  assert.strictEqual(sentBody, '42');
  await bot.handle({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'mal' } }, res);
  assert.strictEqual(status, 403);
});

test('reconoce el mismo teléfono escrito de distintas formas', () => {
  const { phoneTail } = bot._internal;
  const wa = phoneTail('5491155556666');
  for (const p of ['+54 9 11 5555-6666', '011 15 5555-6666', '11-5555-6666']) assert.strictEqual(phoneTail(p), wa, p);
});

test('conectar: suscribe la cuenta de ventas a este webhook', async () => {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => (url.includes('subscribed_apps') ? { success: true } : { display_phone_number: '+54 9 11 7621-1983' }) };
  };
  let status; let body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await bot.handle({ method: 'GET', query: { conectar: '1' }, headers: { host: 'rhinos-crm.vercel.app' } }, res);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.conectado, true);
  assert.match(calls[0].url, /1429719312667513\/subscribed_apps/);
  assert.strictEqual(calls[0].body.override_callback_uri, 'https://rhinos-crm.vercel.app/api/meta?action=wa_ventas');
});

function crmWorld({ email = 'comercial@rhinosapp.com', sendError = null } = {}) {
  const db = {
    rhinos_wa_ventas: [{ phone: '5491133334444', lead_id: 'L9', datos: { rubro: 'quesos' }, calificado: true }],
    rhinos_wa_ventas_msgs: [
      { id: 'a', phone: '5491133334444', role: 'user', texto: 'hola', created_at: new Date(Date.now() - 3600e3).toISOString() },
      { id: 'b', phone: '5491133334444', role: 'bot', texto: '¡Hola!', created_at: new Date().toISOString() },
    ],
    rhinos_leads: [{ id: 'L9', tags: 'bot-whatsapp' }],
    rhinos_lead_interactions: [],
    rhinos_vendedores: [],
  };
  const sent = [];
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const ok = (b, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.hostname === 'www.googleapis.com') return email ? ok({ email }) : ok({}, 401);
    if (u.pathname === '/auth/v1/user') return ok({}, 401);
    if (u.hostname === 'graph.facebook.com') {
      if (sendError) return ok({ error: { message: sendError } }, 400);
      sent.push(JSON.parse(opts.body)); return ok({ messages: [{ id: 'wamid.eq' }] });
    }
    const table = u.pathname.replace('/rest/v1/', '');
    const method = opts.method || 'GET';
    if (method === 'POST') { const rows = JSON.parse(opts.body); db[table].push(...rows); return ok(rows, 201); }
    if (method === 'PATCH') { const id = u.searchParams.get('id').slice(3); Object.assign(db[table].find((r) => r.id === id), JSON.parse(opts.body)); return ok(null, 204); }
    let rows = db[table];
    for (const [k, v] of u.searchParams) {
      if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
      if (v.startsWith('like.')) rows = rows.filter((r) => String(r[k]).endsWith(v.slice(6)));
    }
    return ok(rows);
  };
  return { db, sent };
}

function call(body, auth = 'Bearer ' + 'x'.repeat(30)) {
  return new Promise((resolve) => {
    const res = { status(s) { this.s = s; return this; }, json(b) { resolve({ status: this.s, body: b }); return this; } };
    bot.handleCrm({ method: 'POST', headers: { authorization: auth }, body }, res);
  });
}

test('CRM: sin sesión válida no ve conversaciones', async () => {
  crmWorld({ email: null });
  const r = await call({ op: 'conversacion', lead_id: 'L9' });
  assert.strictEqual(r.status, 401);
});

test('CRM: ve la conversación del lead con la ventana abierta', async () => {
  crmWorld();
  const r = await call({ op: 'conversacion', lead_id: 'L9' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.conversacion.mensajes.length, 2);
  assert.strictEqual(r.body.conversacion.ventana_abierta, true);
});

test('CRM: responder manda por WhatsApp, lo guarda y pausa el bot', async () => {
  const w = crmWorld();
  const r = await call({ op: 'enviar', lead_id: 'L9', texto: 'Hola, soy Manete' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(w.sent[0].to, '5491133334444');
  assert.ok(w.db.rhinos_wa_ventas_msgs.some((m) => m.role === 'equipo'));
  assert.match(w.db.rhinos_leads[0].tags, /bot-pausado/);
});

test('CRM: ventana de 24 h cerrada da un error claro', async () => {
  crmWorld({ sendError: 'Re-engagement message (131047)' });
  const r = await call({ op: 'enviar', lead_id: 'L9', texto: 'hola' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /24 h/);
});

test('bot pausado: cada mensaje avisa al equipo', async () => {
  const w = world({ leads: [{ id: 'L1', name: 'Pepe', phone: '+54 9 11 5555-6666', status: 'contactado', tags: 'bot-pausado' }] });
  await bot.processWebhook(payload('5491155556666', 'hola?', 'wamid.p1'));
  await bot.processWebhook(payload('5491155556666', 'sigo acá', 'wamid.p2'));
  assert.strictEqual(w.notified.length, 2);
  assert.strictEqual(w.sent.length, 0);
});

test('manda la respuesta en varios mensajes, como una persona', async () => {
  const w = world({ aiReplies: [{ mensaje: 'hola! soy de RhinosApp\n\nte cuento rápido cómo funciona\n\nqué distribuís?', datos: {}, calificado: false, temperatura: 'tibio', resumen: '' }] });
  await bot.processWebhook(payload('5491100001111', 'hola', 'wamid.s1'));
  assert.deepStrictEqual(w.sent.map((m) => m.text.body), ['hola! soy de RhinosApp', 'te cuento rápido cómo funciona', 'qué distribuís?']);
  assert.strictEqual(w.db.rhinos_wa_ventas_msgs.filter((m) => m.role === 'bot').length, 3);
});

test('lo que no sabe lo deriva al equipo con la consulta', async () => {
  const w = world({
    config: { wa_recipients: JSON.stringify([{ phone: '5491111', apikey: 'x' }]) },
    aiReplies: [{ mensaje: 'eso te lo confirma alguien del equipo, ya les paso tu consulta', datos: {}, calificado: false, temperatura: 'tibio', resumen: '', derivar: true, consulta: '¿se integra con Tango?' }],
  });
  const [r] = await bot.processWebhook(payload('5491100002222', 'se integra con tango?', 'wamid.d1'));
  assert.strictEqual(r.derivado, true);
  assert.ok(w.notified.some((u) => /callmebot/.test(u) && /Tango/.test(decodeURIComponent(u))));
  assert.ok(w.db.rhinos_lead_interactions.some((i) => /Tango/.test(i.note)));
});

test('las instrucciones piden escribir como persona y no inventar', () => {
  const p = bot._internal.systemPrompt({ extra: '', datos: {}, calificado: false, isNew: true });
  assert.match(p, /minúscula/);
  assert.match(p, /Nunca supongas ni inventes/);
  assert.match(p, /confidencial/);
  assert.match(p, /no lo niegues/);
});
