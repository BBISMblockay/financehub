-- Demo workspaces, declared in data.
--
-- WHY. The daily integration reconcile pass asks "is every client's data
-- actually arriving?" and fails the run when something needs a person. On
-- 2026-11-11 seven of its eight findings were not clients at all: they were
-- the two workspaces kept for vendor app reviews and sales demos, whose
-- connections are deliberately empty shells. The pass had been red for six
-- days on work nobody owed.
--
-- The cleanup on offer was deactivating those connections, which would have
-- reached inside a tenant a vendor reviewer had been invited into. A workspace
-- that is not a customer is the more honest thing to name, and naming it in
-- DATA rather than in the pass keeps SILO generic: which workspaces are demos
-- is a fact about one deployment. Nothing in `scripts/` names a company.
--
-- Scope is deliberately narrow. This flag means "do not judge this workspace
-- as client health". It is NOT a permission, NOT a billing state and NOT a
-- data boundary -- RLS is unchanged and a demo workspace's own members see
-- exactly what they saw before. Anything that needs a real boundary must not
-- be built on this column.
--
-- Defaults to false, so every existing workspace keeps today's behaviour and
-- becoming a demo is always somebody's explicit act.

alter table public.company_settings
  add column if not exists is_demo boolean not null default false;

comment on column public.company_settings.is_demo is
  'True for a workspace kept for a vendor review or a sales demo rather than a customer. '
  'The daily integration reconcile pass skips it, so its deliberately empty connections are '
  'not reported as client health. Not a permission, a billing state or a data boundary: RLS '
  'is unchanged. Set per deployment in data -- no code names a company.';
