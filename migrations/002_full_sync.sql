-- ══════════════════════════════════════════════════════
-- RhinosCRM — Migración 002: Sync completo multi-PC
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════

-- Helper macro para crear policy solo si no existe
CREATE OR REPLACE FUNCTION create_anon_policy(tbl TEXT) RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = tbl AND policyname = 'Allow anon all'
  ) THEN
    EXECUTE format('CREATE POLICY "Allow anon all" ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', tbl);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ── 1. rhinos_recurring_txs — Gastos fijos / recurrentes ──
CREATE TABLE IF NOT EXISTS rhinos_recurring_txs (
  id          TEXT PRIMARY KEY,
  type        TEXT,
  amount      NUMERIC,
  description TEXT,
  category    TEXT,
  partner     TEXT,
  notes       TEXT,
  day         TEXT,
  last_applied TEXT,
  updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE rhinos_recurring_txs ENABLE ROW LEVEL SECURITY;
SELECT create_anon_policy('rhinos_recurring_txs');

-- ── 2. rhinos_pres_tiers — Tiers / precios del presupuestador ──
CREATE TABLE IF NOT EXISTS rhinos_pres_tiers (
  id   TEXT PRIMARY KEY DEFAULT 'default',
  data JSONB NOT NULL DEFAULT '[]'   -- array serializado de tiers
);
ALTER TABLE rhinos_pres_tiers ENABLE ROW LEVEL SECURITY;
SELECT create_anon_policy('rhinos_pres_tiers');

-- ── 3. rhinos_pres_history — Historial de presupuestos ──
CREATE TABLE IF NOT EXISTS rhinos_pres_history (
  id       TEXT PRIMARY KEY,
  fecha    TEXT,
  cliente  TEXT,
  empresa  TEXT,
  validez  TEXT,
  tc       NUMERIC,
  nota     TEXT,
  tiers    JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE rhinos_pres_history ENABLE ROW LEVEL SECURITY;
SELECT create_anon_policy('rhinos_pres_history');

-- ── 4. rhinos_prospect_emails — Emails de prospectos ──
CREATE TABLE IF NOT EXISTS rhinos_prospect_emails (
  place_id TEXT PRIMARY KEY,
  email    TEXT NOT NULL
);
ALTER TABLE rhinos_prospect_emails ENABLE ROW LEVEL SECURITY;
SELECT create_anon_policy('rhinos_prospect_emails');

-- ── 5. rhinos_email_templates — Templates de email de cobro ──
CREATE TABLE IF NOT EXISTS rhinos_email_templates (
  type   TEXT PRIMARY KEY,   -- 'pago' | 'recordatorio' | 'confirmacion' | 'reembolso'
  asunto TEXT,
  cuerpo TEXT
);
ALTER TABLE rhinos_email_templates ENABLE ROW LEVEL SECURITY;
SELECT create_anon_policy('rhinos_email_templates');

-- ── 6. rhinos_balance — Balance general SRL (una fila) ──
CREATE TABLE IF NOT EXISTS rhinos_balance (
  id   TEXT PRIMARY KEY DEFAULT 'default',
  data JSONB NOT NULL DEFAULT '{}'
);
ALTER TABLE rhinos_balance ENABLE ROW LEVEL SECURITY;
SELECT create_anon_policy('rhinos_balance');

-- ── 7. Fix RLS faltante en tablas existentes ──
ALTER TABLE rhinos_clients      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rhinos_tc_historico ENABLE ROW LEVEL SECURITY;
SELECT create_anon_policy('rhinos_clients');
SELECT create_anon_policy('rhinos_tc_historico');

-- Cleanup helper
DROP FUNCTION IF EXISTS create_anon_policy(TEXT);

-- Verificación final
SELECT tablename, rowsecurity FROM pg_tables
WHERE tablename IN (
  'rhinos_transactions','rhinos_clients','rhinos_cobros',
  'rhinos_tc_historico','rhinos_partners','rhinos_recurring_txs',
  'rhinos_pres_tiers','rhinos_pres_history','rhinos_prospect_emails',
  'rhinos_email_templates','rhinos_balance'
)
ORDER BY tablename;
