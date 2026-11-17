-- ══════════════════════════════════════════════════════
-- RhinosCRM — Migración 003: Bot de ventas por WhatsApp
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- Las conversaciones solo las lee el servidor (clave de servicio):
-- no se crea policy para anon.
-- ══════════════════════════════════════════════════════

-- Estado de cada conversación (una por número)
CREATE TABLE IF NOT EXISTS rhinos_wa_ventas (
  phone       TEXT PRIMARY KEY,           -- número en formato WhatsApp (ej. 5491122334455)
  nombre      TEXT,
  lead_id     TEXT,                       -- id en rhinos_leads
  datos       JSONB NOT NULL DEFAULT '{}',-- lo que el bot fue averiguando
  calificado  BOOLEAN NOT NULL DEFAULT FALSE,
  avisado_at  TIMESTAMP WITH TIME ZONE,   -- cuándo se avisó al equipo
  origen      TEXT,                       -- anuncio de Meta, si vino de uno
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE rhinos_wa_ventas ENABLE ROW LEVEL SECURITY;

-- Mensajes (entrantes y del bot). El id es el de WhatsApp: evita duplicados.
CREATE TABLE IF NOT EXISTS rhinos_wa_ventas_msgs (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'bot', 'equipo')),
  texto       TEXT NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rhinos_wa_ventas_msgs_phone_idx
  ON rhinos_wa_ventas_msgs (phone, created_at DESC);
ALTER TABLE rhinos_wa_ventas_msgs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON rhinos_wa_ventas, rhinos_wa_ventas_msgs TO service_role;
