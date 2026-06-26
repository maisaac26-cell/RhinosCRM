// Cron diario — verifica reglas activas y envía push si corresponde
// Vercel cron: 0 12 * * * (12:00 UTC = 9:00 AM Argentina)
const https = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';
const PUSH_URL = 'https://rhinos-crm.vercel.app/api/push';

async function sbGet(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: new URL(SB_URL).hostname, path: '/rest/v1/' + path, method: 'GET',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
    }, res => { let r=''; res.on('data',c=>r+=c); res.on('end',()=>{ try{resolve(JSON.parse(r));}catch(e){resolve([]);} }); });
    req.on('error', () => resolve([])); req.end();
  });
}

async function sbPost(path, data) {
  const body = JSON.stringify(data);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: new URL(SB_URL).hostname, path: '/rest/v1/' + path, method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(body) }
    }, res => { res.on('data',()=>{}); res.on('end',resolve); });
    req.on('error', resolve); req.write(body); req.end();
  });
}

async function sendPush(title, body, tag) {
  return fetch(PUSH_URL, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'send', title, body, url:'/', tag }) }).then(r=>r.json()).catch(()=>({sent:0}));
}

module.exports = async function handler(req, res) {
  const results = [];
  const today = new Date();
  const localMonth = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
  const localDate  = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  // Cargar reglas activas
  const rules = await sbGet('rhinos_notif_rules?activo=eq.true');
  const active = new Set((rules||[]).map(r => r.tipo));

  // ── 1. COBROS VENCIDOS ────────────────────────────────────────────────
  if (active.has('cobros_vencidos')) {
    const cobros = await sbGet(`rhinos_cobros?status=eq.vencido&periodo=eq.${localMonth}`);
    if (cobros?.length) {
      const r = await sendPush(`💳 ${cobros.length} cobro${cobros.length>1?'s':''} vencido${cobros.length>1?'s':''}`,
        `Hay ${cobros.length} cliente${cobros.length>1?'s':''} con cobros vencidos en ${localMonth}. Revisá Finanzas → Clientes & Cobros.`,
        'cobros_vencidos');
      await sbPost('rhinos_notif_log', { tipo:'cobros_vencidos', titulo:`💳 Cobros vencidos`, mensaje:`${cobros.length} cobros vencidos en ${localMonth}`, enviado_a: r.sent||0 });
      results.push({ tipo:'cobros_vencidos', sent: r.sent });
    }
  }

  // ── 2. FOLLOW-UPS VENCIDOS ────────────────────────────────────────────
  if (active.has('followups_vencidos')) {
    const leads = await sbGet(`rhinos_leads?next_followup=lt.${localDate}&status=not.in.(cliente,perdido,imposible)&select=id`);
    if (leads?.length) {
      const r = await sendPush(`📅 ${leads.length} follow-up${leads.length>1?'s':''} vencido${leads.length>1?'s':''}`,
        `${leads.length} lead${leads.length>1?'s':''} requieren seguimiento hoy. Revisá el pipeline.`,
        'followups_vencidos');
      await sbPost('rhinos_notif_log', { tipo:'followups_vencidos', titulo:`📅 Follow-ups vencidos`, mensaje:`${leads.length} follow-ups sin atender`, enviado_a: r.sent||0 });
      results.push({ tipo:'followups_vencidos', sent: r.sent });
    }
  }

  // ── 3. SUELDOS PENDIENTES ─────────────────────────────────────────────
  if (active.has('sueldo_pendiente')) {
    const sueldos = await sbGet(`rhinos_sueldos?periodo=eq.${localMonth}&status=eq.pendiente&select=id`);
    if (sueldos?.length) {
      const r = await sendPush(`👥 ${sueldos.length} sueldo${sueldos.length>1?'s':''} pendiente${sueldos.length>1?'s':''}`,
        `Quedan ${sueldos.length} sueldo${sueldos.length>1?'s':''} por pagar en ${localMonth}. Revisá Finanzas → Empleados.`,
        'sueldo_pendiente');
      await sbPost('rhinos_notif_log', { tipo:'sueldo_pendiente', titulo:`👥 Sueldos pendientes`, mensaje:`${sueldos.length} sueldos sin pagar en ${localMonth}`, enviado_a: r.sent||0 });
      results.push({ tipo:'sueldo_pendiente', sent: r.sent });
    }
  }

  // ── 4. CONTRATOS POR VENCER (próximos 7 días) ─────────────────────────
  if (active.has('contrato_vence')) {
    const in7 = new Date(today); in7.setDate(in7.getDate() + 7);
    const in7str = `${in7.getFullYear()}-${String(in7.getMonth()+1).padStart(2,'0')}-${String(in7.getDate()).padStart(2,'0')}`;
    const clients = await sbGet(`rhinos_clients?contrato_fin=gte.${localDate}&contrato_fin=lte.${in7str}&estado=eq.activo&select=nombre,contrato_fin`);
    if (clients?.length) {
      const nombres = clients.map(c=>c.nombre).join(', ');
      const r = await sendPush(`📋 Contrato${clients.length>1?'s':''} por vencer`,
        `${nombres} — ${clients.length===1?'su contrato vence':'sus contratos vencen'} en los próximos 7 días.`,
        'contrato_vence');
      await sbPost('rhinos_notif_log', { tipo:'contrato_vence', titulo:`📋 Contratos por vencer`, mensaje:nombres, enviado_a: r.sent||0 });
      results.push({ tipo:'contrato_vence', sent: r.sent });
    }
  }

  return res.status(200).json({ ok: true, checked: [...active], results, date: localDate });
};
