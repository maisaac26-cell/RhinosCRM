'use strict';
const https = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

// Transparent 1×1 PNG
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.end(PIXEL);

  const id = (req.query || {}).id;
  if (!id) return;

  const now  = new Date().toISOString();
  const body = JSON.stringify({ ia_abierto: true, ia_ultima_apertura: now, ia_apertura_count: 1, updated_at: now });
  const r = https.request({
    hostname: new URL(SB_URL).hostname,
    path: `/rest/v1/rhinos_prospectos?id=eq.${encodeURIComponent(id)}&ia_abierto=eq.false`,
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      'Prefer': 'return=minimal',
    },
  }, () => {});
  r.on('error', () => {});
  r.end(body);

  // Subsequent opens: just update ia_ultima_apertura
  const body2 = JSON.stringify({ ia_ultima_apertura: now, updated_at: now });
  const r2 = https.request({
    hostname: new URL(SB_URL).hostname,
    path: `/rest/v1/rhinos_prospectos?id=eq.${encodeURIComponent(id)}&ia_abierto=eq.true`,
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body2),
      'Prefer': 'return=minimal',
    },
  }, () => {});
  r2.on('error', () => {});
  r2.end(body2);
};
