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
  assert.deepStrictEqual(r, { replied: true, calificado: false, avisado: false });
  assert.strictEqual(w.db.rhinos_leads.length, 1);
  assert.match(w.db.rhinos_leads[0].notes, /Dejá el Excel/);
  assert.strictEqual(w.db.rhinos_leads[0].source, 'WhatsApp');
  assert.strictEqual(w.sent[0].to, '5491122334455');
  assert.strictEqual(w.db.rhinos_wa_ventas_msgs.length, 2);
  assert.match(w.prompts[0].system, /278\.600/);
  assert.match(w.prompts[0].system, /primer mensaje/);
  assert.strictEqual(w.notified.length, 0);
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
  assert.strictEqual(w.notified.length, 2); // push + WhatsApp del dueño
  assert.match(decodeURIComponent(w.notified[1]), /Lácteos Sur/);
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
