-- ============================================================
-- Stamp company_entity_id on INSERT when the client omits it.
--
-- Worldview safety net: every UI/module insert into a
-- company-scoped table gets active_company_id() when NULL.
-- RLS WITH CHECK still rejects mismatched explicit values.
--
-- Excluded (bulk sync / backfill sets company explicitly):
--   inventory_on_hand, sales_by_day
-- ============================================================

CREATE OR REPLACE FUNCTION public.stamp_company_entity_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.company_entity_id IS NULL THEN
    NEW.company_entity_id := public.active_company_id();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_stamp_company_entity_id_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'company_entity_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('inventory_on_hand', 'sales_by_day')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stamp_company_entity_id ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE TRIGGER stamp_company_entity_id
         BEFORE INSERT ON public.%I
         FOR EACH ROW
         EXECUTE FUNCTION public.stamp_company_entity_id()',
      r.table_name
    );
  END LOOP;
END;
$$;

SELECT public.attach_stamp_company_entity_id_triggers();
