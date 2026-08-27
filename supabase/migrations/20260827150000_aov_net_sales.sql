-- AOV is net sales / orders, matching Shopify.
--
-- Both wow_report and wow_kpi_compare divided TOTAL sales by orders. Total
-- sales includes shipping and tax, so AOV came out about 16% high:
--
--   total_sales / orders  = $81.01   (what the report showed)
--   net_sales   / orders  = $69.87
--   Shopify reports         $69.82
--
-- Caught by checking the figure against Shopify's own analytics rather than
-- only against itself. The order count was already correct (3,203 for
-- 2026-08-19..25, against Shopify's own 3,200-3,300) -- only the numerator
-- was wrong, which is why the error was invisible from inside SILO: every
-- component reconciled, the combination did not.
--
-- wow_report is patched in place by rewriting its deployed definition, with a
-- guard that raises if the expected expression is absent, rather than
-- retyping a long function body.
do $$
declare def text; newdef text; old_expr text; new_expr text;
begin
  def := pg_get_functiondef('public.wow_report(date)'::regprocedure);
  old_expr := E'''aov'', round((t.tot/nullif((select count(*) from ord),0))::numeric,2)) from totals t)';
  new_expr := E'''aov'', round((t.net/nullif((select count(*) from ord),0))::numeric,2)) from totals t)';
  if position(old_expr in def) = 0 then
    raise notice 'aov expression not found; leaving wow_report as-is';
    return;
  end if;
  newdef := replace(def, old_expr, new_expr);
  execute newdef;
end $$;
