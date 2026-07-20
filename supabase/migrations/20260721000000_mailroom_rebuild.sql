-- ============================================================
-- Mailroom rebuild: native SILO schema replacing the Jotform/Google
-- Sheets + localStorage setup in the legacy /mailroom.html tool.
--
-- The old tool had no real backend at all: its "Sync Supabase" button
-- targeted a mailroom_items table that never existed in this project,
-- so every write silently failed. The entire live view was driven by
-- a public Google Sheet plus per-browser localStorage for the fields
-- that actually mattered (done/archived/notes) -- meaning two staff on
-- two computers saw different processing status for the same mail.
--
-- mail_items / mail_item_files / mail_item_activity mirror the
-- payment_requests / payment_request_files / payment_request_activity
-- shape (same session, same lesson applied up front this time: the
-- full activity_type set is enumerated now, not discovered the hard
-- way via a missing-constraint bug like payment_request_activity's
-- file_uploaded gap).
--
-- RLS here is intentionally simpler than payment_requests: mailroom is
-- a shared team inbox, not a financial-approval flow, so read/write is
-- open to any authenticated member of the active company (matching the
-- launch_system_links / launch_product_readiness pattern) rather than
-- scoped to creator/admin. Delete is admin-only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mail_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_entity_id uuid REFERENCES public.entities(id),

  subject text NOT NULL,
  sender text,
  document_type text,
  priority text NOT NULL DEFAULT 'P2',

  received_date date,
  due_date date,
  action_needed text,
  notes text,

  assigned_to uuid REFERENCES public.profiles(id),
  processed_by uuid REFERENCES public.profiles(id),
  submitted_by uuid REFERENCES public.profiles(id),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done', 'archived')),

  -- Backfill provenance from the retired Google Sheet/Jotform pipeline.
  legacy_submission_id text,
  legacy_source text,

  created_by uuid REFERENCES public.profiles(id),
  updated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mail_items_legacy_submission_id_key
  ON public.mail_items (legacy_submission_id)
  WHERE legacy_submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mail_items_company_status_idx
  ON public.mail_items (company_entity_id, status);
CREATE INDEX IF NOT EXISTS mail_items_assigned_to_idx
  ON public.mail_items (assigned_to);

CREATE TABLE IF NOT EXISTS public.mail_item_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_item_id uuid NOT NULL REFERENCES public.mail_items(id) ON DELETE CASCADE,
  company_entity_id uuid REFERENCES public.entities(id),

  file_name text,
  file_path text,
  file_url text,
  file_size bigint,
  mime_type text,
  sort_order int DEFAULT 1,

  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_item_files_mail_item_id_idx
  ON public.mail_item_files (mail_item_id);

CREATE TABLE IF NOT EXISTS public.mail_item_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_item_id uuid NOT NULL REFERENCES public.mail_items(id) ON DELETE CASCADE,
  company_entity_id uuid REFERENCES public.entities(id),

  activity_type text NOT NULL CHECK (activity_type IN (
    'submitted',
    'status_changed',
    'assignment_changed',
    'priority_changed',
    'note_added',
    'file_uploaded',
    'notification_sent',
    'imported',
    'updated'
  )),
  field_name text,
  old_value text,
  new_value text,
  message text,

  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_item_activity_mail_item_id_idx
  ON public.mail_item_activity (mail_item_id);

-- Enriched view for the workbench UI (assignee/submitter/processor names).
CREATE OR REPLACE VIEW public.mail_items_v
WITH (security_invoker = true) AS
SELECT
  mi.*,
  assigned.name AS assigned_to_name,
  assigned.email AS assigned_to_email,
  submitted.name AS submitted_by_name,
  submitted.email AS submitted_by_email,
  processed.name AS processed_by_name,
  processed.email AS processed_by_email
FROM public.mail_items mi
LEFT JOIN public.profiles assigned ON assigned.id = mi.assigned_to
LEFT JOIN public.profiles submitted ON submitted.id = mi.submitted_by
LEFT JOIN public.profiles processed ON processed.id = mi.processed_by;

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.mail_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_item_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_item_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mail_items_active_select" ON public.mail_items;
DROP POLICY IF EXISTS "mail_items_active_write" ON public.mail_items;
DROP POLICY IF EXISTS "mail_items_active_delete" ON public.mail_items;
DROP POLICY IF EXISTS "mail_item_files_active_select" ON public.mail_item_files;
DROP POLICY IF EXISTS "mail_item_files_active_write" ON public.mail_item_files;
DROP POLICY IF EXISTS "mail_item_files_active_delete" ON public.mail_item_files;
DROP POLICY IF EXISTS "mail_item_activity_active_select" ON public.mail_item_activity;
DROP POLICY IF EXISTS "mail_item_activity_active_insert" ON public.mail_item_activity;

CREATE POLICY "mail_items_active_select" ON public.mail_items
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "mail_items_active_write" ON public.mail_items
  FOR INSERT WITH CHECK (company_entity_id = active_company_id());
CREATE POLICY "mail_items_active_update" ON public.mail_items
  FOR UPDATE USING (company_entity_id = active_company_id())
             WITH CHECK (company_entity_id = active_company_id());
CREATE POLICY "mail_items_active_delete" ON public.mail_items
  FOR DELETE USING (company_entity_id = active_company_id() AND is_admin_user());

CREATE POLICY "mail_item_files_active_select" ON public.mail_item_files
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "mail_item_files_active_insert" ON public.mail_item_files
  FOR INSERT WITH CHECK (company_entity_id = active_company_id());
CREATE POLICY "mail_item_files_active_delete" ON public.mail_item_files
  FOR DELETE USING (company_entity_id = active_company_id() AND is_admin_user());

CREATE POLICY "mail_item_activity_active_select" ON public.mail_item_activity
  FOR SELECT USING (company_entity_id = active_company_id());
CREATE POLICY "mail_item_activity_active_insert" ON public.mail_item_activity
  FOR INSERT WITH CHECK (company_entity_id = active_company_id());

-- Attribution + company-scoping safety nets (same pattern as every
-- other table in the app -- see stamp_created_by / stamp_company_entity_id).
DROP TRIGGER IF EXISTS stamp_created_by ON public.mail_items;
CREATE TRIGGER stamp_created_by BEFORE INSERT ON public.mail_items
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_by();

DROP TRIGGER IF EXISTS stamp_created_by ON public.mail_item_files;
CREATE TRIGGER stamp_created_by BEFORE INSERT ON public.mail_item_files
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_by();

DROP TRIGGER IF EXISTS stamp_created_by ON public.mail_item_activity;
CREATE TRIGGER stamp_created_by BEFORE INSERT ON public.mail_item_activity
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_by();

-- Re-run the existing auto-discovery attacher so the three new
-- company_entity_id columns above get the same NULL-fill-on-insert
-- safety net every other company-scoped table has.
SELECT public.attach_stamp_company_entity_id_triggers();

-- ── Storage bucket for mail attachments ─────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('mail-item-files', 'mail-item-files', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "mail item files read by authenticated users" ON storage.objects;
DROP POLICY IF EXISTS "mail item files upload by authenticated users" ON storage.objects;
DROP POLICY IF EXISTS "mail item files update by authenticated users" ON storage.objects;
DROP POLICY IF EXISTS "mail item files delete by authenticated users" ON storage.objects;

CREATE POLICY "mail item files read by authenticated users"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'mail-item-files');
CREATE POLICY "mail item files upload by authenticated users"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'mail-item-files');
CREATE POLICY "mail item files update by authenticated users"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'mail-item-files')
  WITH CHECK (bucket_id = 'mail-item-files');
CREATE POLICY "mail item files delete by authenticated users"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'mail-item-files');
