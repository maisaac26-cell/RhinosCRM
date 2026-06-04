-- ══════════════════════════════════════════════════════
-- RhinosCRM — Migración 001: Sync cobros + columnas clientes
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════

-- 1. Agregar columnas faltantes a rhinos_clients (idempotente)
ALTER TABLE rhinos_clients ADD COLUMN IF NOT EXISTS empresa    TEXT;
ALTER TABLE rhinos_clients ADD COLUMN IF NOT EXISTS emails_cc  TEXT;
ALTER TABLE rhinos_clients ADD COLUMN IF NOT EXISTS moneda     TEXT DEFAULT 'ARS';
ALTER TABLE rhinos_clients ADD COLUMN IF NOT EXISTS dias_plazo INTEGER DEFAULT 10;
ALTER TABLE rhinos_clients ADD COLUMN IF NOT EXISTS inicio     TEXT;
ALTER TABLE rhinos_clients ADD COLUMN IF NOT EXISTS estado     TEXT DEFAULT 'activo';
ALTER TABLE rhinos_clients ADD COLUMN IF NOT EXISTS notas      TEXT;
ALTER TABLE rhinos_clients ADD COLUMN IF NOT EXISTS "createdAt" TEXT;

-- 2. Crear tabla rhinos_cobros
CREATE TABLE IF NOT EXISTS rhinos_cobros (
  id          TEXT PRIMARY KEY,               -- "<clientId>_<periodo>"
  "clientId"  TEXT    NOT NULL,
  periodo     TEXT    NOT NULL,               -- "2026-06"
  status      TEXT    NOT NULL DEFAULT 'pendiente',
  monto       NUMERIC NOT NULL DEFAULT 0,
  "fechaPago" TEXT,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE ("clientId", periodo)
);

-- 3. RLS para rhinos_cobros (mismo esquema que el resto del proyecto)
ALTER TABLE rhinos_cobros ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'rhinos_cobros' AND policyname = 'Allow anon all'
  ) THEN
    CREATE POLICY "Allow anon all" ON rhinos_cobros
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Verificar que todo quedó bien
SELECT 'rhinos_clients columns:' AS info, column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'rhinos_clients'
 ORDER BY ordinal_position;

SELECT 'rhinos_cobros created:' AS info, tablename
  FROM pg_tables WHERE tablename = 'rhinos_cobros';
