'use strict';
const https = require('https');

const SB_URL = 'https://konbqkvrcnxzpltxjdyj.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvbmJxa3ZyY254enBsdHhqZHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDg1MDQsImV4cCI6MjA4OTYyNDUwNH0.vya3WNSXf-GLaF9i1atTyB_l5LN91g45-SwhE-Dhalc';

const WSAA_HOMO = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
const WSAA_PROD = 'https://wsaa.afip.gov.ar/ws/services/LoginCms';
const WSFE_HOMO = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';
const WSFE_PROD = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx';

// ── Supabase helpers ─────────────────────────────────────────────────────────

function sbRequest(path, method, body) {
  const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
  const headers = {
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
  };
  if (data) {
    headers['Content-Length'] = data.length;
    headers['Prefer'] = 'resolution=merge-duplicates,return=minimal';
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'konbqkvrcnxzpltxjdyj.supabase.co',
      path: '/rest/v1/' + path,
      method,
      headers,
    }, (r) => {
      let raw = '';
      r.on('data', c => raw += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: raw ? JSON.parse(raw) : null }); }
        catch(e) { resolve({ status: r.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function sbGet(table, filter) {
  const r = await sbRequest(table + (filter ? '?' + filter : ''), 'GET');
  return Array.isArray(r.body) ? r.body : [];
}

async function sbUpsert(table, rows) {
  return sbRequest(table, 'POST', rows);
}

// ── AFIP config from rhinos_config ──────────────────────────────────────────

const CFG_KEYS = [
  'afip_cuit', 'afip_razon_social', 'afip_domicilio', 'afip_condicion_iva',
  'afip_punto_venta', 'afip_tipo_cbte', 'afip_ambiente',
  'afip_cert', 'afip_key',
  'afip_tam_token', 'afip_tam_sign', 'afip_tam_exp',
];

async function getAfipConfig() {
  const rows = await sbGet('rhinos_config', 'key=in.(' + CFG_KEYS.join(',') + ')');
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });
  return cfg;
}

// ── PKCS#7 CMS signing (node-forge) ─────────────────────────────────────────

function firmarCMS(traXml, certPem, keyPem) {
  const forge = require('node-forge');
  const cert = forge.pki.certificateFromPem(certPem.trim());
  const key = forge.pki.privateKeyFromPem(keyPem.trim());

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();

  const derBytes = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(derBytes);
}

// ── TRA (Ticket de Requerimiento de Acceso) XML ──────────────────────────────

function createTRA() {
  const now = new Date();
  const exp = new Date(now.getTime() + 10 * 60 * 1000);
  const fmt = d => d.toISOString().replace(/\.\d+Z$/, '-03:00');
  const uid = Math.floor(Math.random() * 2147483647);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<loginTicketRequest version="1.0">\n  <header>\n    <uniqueId>${uid}</uniqueId>\n    <generationTime>${fmt(now)}</generationTime>\n    <expirationTime>${fmt(exp)}</expirationTime>\n  </header>\n  <service>wsfe</service>\n</loginTicketRequest>`;
}

// ── SOAP helper ──────────────────────────────────────────────────────────────

function soapCall(url, soapAction, body) {
  const data = Buffer.from(body, 'utf8');
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'SOAPAction': soapAction || '""',
        'Content-Length': data.length,
      },
    }, (r) => {
      let raw = '';
      r.on('data', c => raw += c);
      r.on('end', () => resolve({ status: r.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('SOAP timeout')));
    req.write(data);
    req.end();
  });
}

// Simple XML tag extractor — handles HTML entity encoding
function xmlVal(xml, tag) {
  const re = new RegExp('<(?:[^:>]+:)?' + tag + '[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?' + tag + '>', 'i');
  const m = xml.match(re);
  if (!m) return null;
  return m[1].trim()
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ── WSAA auth ────────────────────────────────────────────────────────────────

async function wsaaLogin(certPem, keyPem, ambiente) {
  const tra = createTRA();
  const cms = firmarCMS(tra, certPem, keyPem);
  const wsaaUrl = ambiente === 'produccion' ? WSAA_PROD : WSAA_HOMO;

  const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.wsaa/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:loginCms>
      <ar:in0>${cms}</ar:in0>
    </ar:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const resp = await soapCall(wsaaUrl, '"loginCms"', soapBody);
  if (resp.status !== 200) {
    const fault = xmlVal(resp.body, 'faultstring') || resp.body.slice(0, 300);
    throw new Error(`WSAA HTTP ${resp.status}: ${fault}`);
  }

  // The loginCmsReturn contains the inner XML as HTML entities
  // Try entity-encoded pattern first (most common)
  const tokM = resp.body.match(/&lt;token&gt;([\s\S]*?)&lt;\/token&gt;/i);
  const sigM = resp.body.match(/&lt;sign&gt;([\s\S]*?)&lt;\/sign&gt;/i);
  const expM = resp.body.match(/&lt;expirationTime&gt;([\s\S]*?)&lt;\/expirationTime&gt;/i);

  if (tokM && sigM) {
    return { token: tokM[1].trim(), sign: sigM[1].trim(), exp: expM ? expM[1].trim() : null };
  }

  // Fallback: try direct XML
  const inner = xmlVal(resp.body, 'loginCmsReturn') || xmlVal(resp.body, 'loginCmsResult') || resp.body;
  const token = xmlVal(inner, 'token');
  const sign = xmlVal(inner, 'sign');
  const exp = xmlVal(inner, 'expirationTime');

  if (!token || !sign) {
    const err = xmlVal(resp.body, 'faultstring') || xmlVal(resp.body, 'Msg') || resp.body.slice(0, 400);
    throw new Error('WSAA error — sin token en respuesta: ' + err);
  }
  return { token, sign, exp };
}

// ── Get or refresh TAM ───────────────────────────────────────────────────────

async function getOrRefreshTAM(cfg) {
  if (cfg.afip_tam_token && cfg.afip_tam_sign && cfg.afip_tam_exp) {
    const exp = new Date(cfg.afip_tam_exp);
    if (exp > new Date(Date.now() + 5 * 60 * 1000)) {
      return { token: cfg.afip_tam_token, sign: cfg.afip_tam_sign };
    }
  }
  if (!cfg.afip_cert || !cfg.afip_key) {
    throw new Error('Falta el certificado o clave privada. Guardá la configuración AFIP primero.');
  }
  const tam = await wsaaLogin(cfg.afip_cert, cfg.afip_key, cfg.afip_ambiente || 'homologacion');
  const expIso = tam.exp || new Date(Date.now() + 11 * 60 * 60 * 1000).toISOString();
  await sbUpsert('rhinos_config', [
    { key: 'afip_tam_token', value: tam.token },
    { key: 'afip_tam_sign', value: tam.sign },
    { key: 'afip_tam_exp', value: expIso },
  ]);
  return { token: tam.token, sign: tam.sign };
}

// ── WSFE calls ───────────────────────────────────────────────────────────────

async function wsfeUltimoCbte(cfg, token, sign, ptoVta, tipoCbte) {
  const wsfeUrl = cfg.afip_ambiente === 'produccion' ? WSFE_PROD : WSFE_HOMO;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <FECompUltimoAutorizado xmlns="http://ar.gov.afip.dif.FEV1/">
      <Auth>
        <Token>${token}</Token>
        <Sign>${sign}</Sign>
        <Cuit>${cfg.afip_cuit}</Cuit>
      </Auth>
      <PtoVta>${ptoVta}</PtoVta>
      <CbteTipo>${tipoCbte}</CbteTipo>
    </FECompUltimoAutorizado>
  </soap12:Body>
</soap12:Envelope>`;
  const resp = await soapCall(wsfeUrl, '', body);
  const num = xmlVal(resp.body, 'CbteNro');
  if (num === null) {
    const err = xmlVal(resp.body, 'ErrMsg') || xmlVal(resp.body, 'faultstring') || resp.body.slice(0, 200);
    throw new Error('WSFE UltimoCbte: ' + err);
  }
  return parseInt(num, 10);
}

async function wsfeSolicitarCAE(cfg, token, sign, inv) {
  const wsfeUrl = cfg.afip_ambiente === 'produccion' ? WSFE_PROD : WSFE_HOMO;
  const tipoCbte = inv.tipoCbte;

  // Only Factura A (1,2,3) discriminates IVA
  const esFacturaA = tipoCbte === 1 || tipoCbte === 2 || tipoCbte === 3;

  const ivaBlock = esFacturaA && inv.alicuotaId !== 3
    ? `<Iva><AlicIva><Id>${inv.alicuotaId}</Id><BaseImp>${inv.impNeto.toFixed(2)}</BaseImp><Importe>${inv.impIva.toFixed(2)}</Importe></AlicIva></Iva>`
    : '';

  const servicioBlock = (inv.concepto === 2 || inv.concepto === 3)
    ? `<FchServDesde>${inv.periodoDesde}</FchServDesde><FchServHasta>${inv.periodoHasta}</FchServHasta><FchVtoPago>${inv.fecha}</FchVtoPago>`
    : '';

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">
      <Auth>
        <Token>${token}</Token>
        <Sign>${sign}</Sign>
        <Cuit>${cfg.afip_cuit}</Cuit>
      </Auth>
      <FeCAEReq>
        <FeCabReq>
          <CantReg>1</CantReg>
          <PtoVta>${inv.ptoVta}</PtoVta>
          <CbteTipo>${tipoCbte}</CbteTipo>
        </FeCabReq>
        <FeDetReq>
          <FECAEDetRequest>
            <Concepto>${inv.concepto}</Concepto>
            <DocTipo>${inv.docTipo}</DocTipo>
            <DocNro>${inv.docNro}</DocNro>
            <CbteDesde>${inv.numero}</CbteDesde>
            <CbteHasta>${inv.numero}</CbteHasta>
            <CbteFch>${inv.fecha}</CbteFch>
            <ImpTotal>${inv.impTotal.toFixed(2)}</ImpTotal>
            <ImpTotConc>0.00</ImpTotConc>
            <ImpNeto>${inv.impNeto.toFixed(2)}</ImpNeto>
            <ImpOpEx>0.00</ImpOpEx>
            <ImpIVA>${inv.impIva.toFixed(2)}</ImpIVA>
            <ImpTrib>0.00</ImpTrib>
            ${servicioBlock}
            <MonId>${inv.monedaId}</MonId>
            <MonCotiz>${inv.monedaId === 'PES' ? 1 : inv.monCotiz || 1}</MonCotiz>
            ${ivaBlock}
          </FECAEDetRequest>
        </FeDetReq>
      </FeCAEReq>
    </FECAESolicitar>
  </soap12:Body>
</soap12:Envelope>`;

  const resp = await soapCall(wsfeUrl, '', body);
  const resultado = xmlVal(resp.body, 'Resultado');
  const cae = xmlVal(resp.body, 'CAE');
  const caeFchVto = xmlVal(resp.body, 'CAEFchVto');

  if (resultado !== 'A' || !cae) {
    const obs = xmlVal(resp.body, 'Msg') || xmlVal(resp.body, 'ErrMsg') || xmlVal(resp.body, 'faultstring') || resp.body.slice(0, 400);
    throw new Error('AFIP rechazó la factura: ' + obs);
  }
  return { cae, caeFchVto };
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function fmtAfip(dateStr) {
  // AFIP format: YYYYMMDD  ←  from  YYYY-MM-DD or YYYYMMDD
  return dateStr ? dateStr.replace(/-/g, '').slice(0, 8) : '';
}

function fmtIso(afipDate) {
  if (!afipDate || afipDate.length < 8) return afipDate;
  return `${afipDate.slice(0,4)}-${afipDate.slice(4,6)}-${afipDate.slice(6,8)}`;
}

// ── Request body parser ───────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch(e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  let body;
  try { body = await readBody(req); }
  catch(e) { return res.status(400).json({ error: e.message }); }

  const { action } = body;

  try {
    // ── save_config ──────────────────────────────────────────────────
    if (action === 'save_config') {
      const allowed = ['afip_cuit', 'afip_razon_social', 'afip_domicilio', 'afip_condicion_iva',
                       'afip_punto_venta', 'afip_tipo_cbte', 'afip_ambiente', 'afip_cert', 'afip_key'];
      const rows = allowed.filter(k => body[k] !== undefined).map(k => ({ key: k, value: String(body[k]) }));
      if (rows.length) await sbUpsert('rhinos_config', rows);
      // Invalidate TAM whenever cert or key changes
      if (body.afip_cert !== undefined || body.afip_key !== undefined || body.afip_ambiente !== undefined) {
        await sbUpsert('rhinos_config', [{ key: 'afip_tam_exp', value: '' }]);
      }
      return res.json({ ok: true });
    }

    // ── get_config ───────────────────────────────────────────────────
    if (action === 'get_config') {
      const cfg = await getAfipConfig();
      // Don't expose TAM or full cert/key to the UI
      const safe = {
        afip_cuit: cfg.afip_cuit || '',
        afip_razon_social: cfg.afip_razon_social || '',
        afip_domicilio: cfg.afip_domicilio || '',
        afip_condicion_iva: cfg.afip_condicion_iva || 'RI',
        afip_punto_venta: cfg.afip_punto_venta || '1',
        afip_tipo_cbte: cfg.afip_tipo_cbte || '6',
        afip_ambiente: cfg.afip_ambiente || 'homologacion',
        has_cert: !!cfg.afip_cert,
        has_key: !!cfg.afip_key,
        tam_valid: !!(cfg.afip_tam_exp && new Date(cfg.afip_tam_exp) > new Date()),
      };
      return res.json({ ok: true, config: safe });
    }

    // ── test_auth ────────────────────────────────────────────────────
    if (action === 'test_auth') {
      const cfg = await getAfipConfig();
      if (!cfg.afip_cuit) throw new Error('Falta CUIT en la configuración.');
      if (!cfg.afip_cert) throw new Error('Falta el certificado digital (.crt).');
      if (!cfg.afip_key) throw new Error('Falta la clave privada (.key).');
      const tam = await wsaaLogin(cfg.afip_cert, cfg.afip_key, cfg.afip_ambiente || 'homologacion');
      const expIso = tam.exp || new Date(Date.now() + 11 * 60 * 60 * 1000).toISOString();
      await sbUpsert('rhinos_config', [
        { key: 'afip_tam_token', value: tam.token },
        { key: 'afip_tam_sign', value: tam.sign },
        { key: 'afip_tam_exp', value: expIso },
      ]);
      const env = cfg.afip_ambiente === 'produccion' ? 'PRODUCCIÓN' : 'homologación';
      return res.json({ ok: true, message: `✅ Conexión exitosa con AFIP WSAA (${env}). Token válido hasta ${expIso.slice(0, 16).replace('T', ' ')}.` });
    }

    // ── ultimo_cbte ──────────────────────────────────────────────────
    if (action === 'ultimo_cbte') {
      const cfg = await getAfipConfig();
      const { token, sign } = await getOrRefreshTAM(cfg);
      const ptoVta = parseInt(cfg.afip_punto_venta || '1', 10);
      const tipoCbte = parseInt(cfg.afip_tipo_cbte || '6', 10);
      const num = await wsfeUltimoCbte(cfg, token, sign, ptoVta, tipoCbte);
      return res.json({ ok: true, numero: num, siguiente: num + 1 });
    }

    // ── emitir ───────────────────────────────────────────────────────
    if (action === 'emitir') {
      const cfg = await getAfipConfig();
      if (!cfg.afip_cuit) throw new Error('Configurá el CUIT antes de emitir.');
      const { token, sign } = await getOrRefreshTAM(cfg);

      const ptoVta = parseInt(body.punto_venta || cfg.afip_punto_venta || '1', 10);
      const tipoCbte = parseInt(body.tipo_cbte || cfg.afip_tipo_cbte || '6', 10);
      const ambiente = cfg.afip_ambiente || 'homologacion';
      const esFacturaA = tipoCbte === 1 || tipoCbte === 2 || tipoCbte === 3;
      const concepto = parseInt(body.concepto || '2', 10);
      const docTipo = parseInt(body.doc_tipo || '80', 10);
      const docNro = String(body.doc_nro || '0').replace(/\D/g, '') || '0';
      const monedaId = body.moneda_id || 'PES';
      const alicuotaId = parseInt(body.alicuota_id || '5', 10);
      const fecha = fmtAfip(body.fecha || new Date().toISOString().slice(0, 10));
      const periodoDesde = fmtAfip(body.periodo_desde || body.fecha || new Date().toISOString().slice(0, 10));
      const periodoHasta = fmtAfip(body.periodo_hasta || body.fecha || new Date().toISOString().slice(0, 10));
      const monCotiz = parseFloat(body.mon_cotiz || '1');

      // Amounts
      const impTotal = parseFloat(body.imp_total || 0);
      let impNeto, impIva;
      if (esFacturaA) {
        const ALIC = { 3: 0, 4: 0.105, 5: 0.21, 6: 0.27, 8: 0.05, 9: 0.025 };
        const rate = ALIC[alicuotaId] || 0.21;
        impNeto = parseFloat(body.imp_neto || impTotal);
        impIva = parseFloat(body.imp_iva || (impNeto * rate));
      } else {
        impNeto = impTotal;
        impIva = 0;
      }

      // Get next number
      let ultimoNum = 0;
      try { ultimoNum = await wsfeUltimoCbte(cfg, token, sign, ptoVta, tipoCbte); } catch(e) { /* first */ }
      const numero = ultimoNum + 1;

      const { cae, caeFchVto } = await wsfeSolicitarCAE(cfg, token, sign, {
        ptoVta, tipoCbte, concepto, docTipo, docNro,
        impNeto, impIva, impTotal, alicuotaId,
        monedaId, monCotiz, fecha, periodoDesde, periodoHasta, numero,
      });

      // Save to rhinos_facturas
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const factura = {
        id,
        cliente_id: body.cliente_id || null,
        cliente_nombre: body.cliente_nombre || '',
        cliente_cuit: docNro,
        tipo_cbte: tipoCbte,
        punto_venta: ptoVta,
        numero,
        fecha_cbte: fmtIso(fecha),
        concepto,
        descripcion: body.descripcion || '',
        periodo_desde: fmtIso(periodoDesde),
        periodo_hasta: fmtIso(periodoHasta),
        imp_neto: impNeto,
        imp_iva: impIva,
        imp_total: impTotal,
        alicuota_id: alicuotaId,
        moneda_id: monedaId,
        cae,
        cae_fch_vto: fmtIso(caeFchVto),
        estado: ambiente === 'produccion' ? 'emitida' : 'homologacion',
        cobro_id: body.cobro_id || null,
      };

      await sbUpsert('rhinos_facturas', [factura]);
      return res.json({ ok: true, factura, cae, caeFchVto: fmtIso(caeFchVto), numero, ambiente });
    }

    // ── list_facturas ────────────────────────────────────────────────
    if (action === 'list_facturas') {
      const rows = await sbGet('rhinos_facturas', 'order=created_at.desc&limit=200');
      return res.json({ ok: true, facturas: rows });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch(e) {
    console.error('[afip]', action, e.message);
    return res.status(500).json({ ok: false, error: e.message || 'Error interno' });
  }
};
