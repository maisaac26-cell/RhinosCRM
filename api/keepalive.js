const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

  try {
    const ping = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: new URL(SB_URL).hostname,
        path: '/rest/v1/rhinos_transactions?limit=1',
        method: 'GET',
        headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
      }, (r) => {
        let raw = ''; r.on('data', c => raw += c);
        r.on('end', () => resolve({ status: r.statusCode }));
      });
      req2.on('error', reject); req2.end();
    });

    return res.status(200).json({
      ok: true,
      supabase_status: ping.status,
      timestamp: new Date().toISOString(),
      message: 'Supabase keep-alive ping exitoso'
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
