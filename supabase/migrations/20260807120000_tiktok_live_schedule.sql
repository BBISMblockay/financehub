-- ============================================================
-- 20260807120000_tiktok_live_schedule.sql
--
-- TikTok Live schedule/claim board (/v2/live-schedule.html).
--
-- SILO users claim hourly slots for running TikTok Lives. The
-- business rule is ONE live at a time for the whole company: the
-- four timezone columns in the UI (PST/MTN/CTRL/EST) are the same
-- absolute moment rendered four ways, so exclusivity is enforced
-- with a plain unique index on (company_entity_id, slot_start).
-- That also makes claiming race-safe — two users clicking the same
-- slot resolve at the database, not in the UI. slot_start is stored
-- as timestamptz (UTC); the page renders it per zone, which handles
-- PST-vs-PDT daylight saving for free.
--
-- If the rule ever loosens to one-live-per-location, widen the
-- unique index to (company_entity_id, slot_start, live_location) —
-- nothing else needs to change.
--
-- Unclaiming deletes the row (only the claimer, only while still
-- 'claimed'), so the unique index needs no status carve-out.
--
-- Finalizing a session stamps gross sales + commission (rate is
-- stored on the row at finalize time so history survives a future
-- rate change) and links the auto-created payment_requests row —
-- the payout rides the existing AP pipeline (Request Manager,
-- notifications, Melio forwarding), nothing new on that side.
--
-- RLS posture matches mailroom/reviews, not the PO tables: any
-- active member of the company can claim and finalize their own
-- sessions; no admin role needed. Admins can release/fix any row.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_entity_id uuid REFERENCES public.entities(id),

  slot_start timestamptz NOT NULL,
  live_location text,
  notes text,

  claimed_by uuid NOT NULL REFERENCES public.profiles(id),
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'finalized')),

  -- Close-out (finalize) fields
  gross_sales numeric(14,2),
  commission_rate numeric(6,4) NOT NULL DEFAULT 0.03,
  commission_amount numeric(14,2),
  payee_name text,
  payment_request_id uuid REFERENCES public.payment_requests(id) ON DELETE SET NULL,
  finalized_at timestamptz,

  created_by uuid REFERENCES public.profiles(id),
  updated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live at a time, company-wide (see header note about loosening later).
CREATE UNIQUE INDEX IF NOT EXISTS live_sessions_company_slot_key
  ON public.live_sessions (company_entity_id, slot_start);

CREATE INDEX IF NOT EXISTS live_sessions_claimed_by_idx
  ON public.live_sessions (claimed_by);
CREATE INDEX IF NOT EXISTS live_sessions_company_status_idx
  ON public.live_sessions (company_entity_id, status);

-- Enriched view for the board UI (claimer name/email/avatar).
CREATE OR REPLACE VIEW public.live_sessions_v
WITH (security_invoker = true) AS
SELECT
  ls.*,
  claimer.name AS claimed_by_name,
  claimer.email AS claimed_by_email,
  claimer.avatar_url AS claimed_by_avatar_url
FROM public.live_sessions ls
LEFT JOIN public.profiles claimer ON claimer.id = ls.claimed_by;

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.live_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "live_sessions_active_select" ON public.live_sessions;
DROP POLICY IF EXISTS "live_sessions_active_insert" ON public.live_sessions;
DROP POLICY IF EXISTS "live_sessions_active_update" ON public.live_sessions;
DROP POLICY IF EXISTS "live_sessions_active_delete" ON public.live_sessions;

CREATE POLICY "live_sessions_active_select" ON public.live_sessions
  FOR SELECT USING (company_entity_id = active_company_id());

-- Claim your own slot; admins may also assign a slot to someone else
-- (the sheet's "Assigned to / Claimed by" column).
CREATE POLICY "live_sessions_active_insert" ON public.live_sessions
  FOR INSERT WITH CHECK (
    company_entity_id = active_company_id()
    AND (claimed_by = auth.uid() OR is_admin_user())
  );

CREATE POLICY "live_sessions_active_update" ON public.live_sessions
  FOR UPDATE
  USING (
    company_entity_id = active_company_id()
    AND (claimed_by = auth.uid() OR is_admin_user())
  )
  WITH CHECK (company_entity_id = active_company_id());

-- Unclaim: claimer while still 'claimed'; admins can release anything.
CREATE POLICY "live_sessions_active_delete" ON public.live_sessions
  FOR DELETE USING (
    company_entity_id = active_company_id()
    AND ((claimed_by = auth.uid() AND status = 'claimed') OR is_admin_user())
  );

-- Attribution + company-scoping safety nets (same pattern as every
-- other table — see stamp_created_by / stamp_company_entity_id).
DROP TRIGGER IF EXISTS stamp_created_by ON public.live_sessions;
CREATE TRIGGER stamp_created_by BEFORE INSERT ON public.live_sessions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_by();

SELECT public.attach_stamp_company_entity_id_triggers();
