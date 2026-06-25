-- Allow the heavy sales verification summary refresh to run up to 5 minutes
-- Default Supabase statement_timeout (8s) is too short for full-table aggregation
ALTER FUNCTION public.refresh_sales_verification_store_comp_summary()
  SET statement_timeout = '300s';
