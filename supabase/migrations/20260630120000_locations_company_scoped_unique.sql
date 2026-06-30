-- Multi-tenant: location_code and location_name were globally unique (legacy).
-- test-co "chicago" blocked Baseballism from creating the same code.
-- Scope uniqueness per company_entity_id.

ALTER TABLE public.locations DROP CONSTRAINT IF EXISTS locations_location_code_key;
ALTER TABLE public.locations DROP CONSTRAINT IF EXISTS locations_location_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS locations_company_location_code_key
  ON public.locations (company_entity_id, location_code);

CREATE UNIQUE INDEX IF NOT EXISTS locations_company_location_name_key
  ON public.locations (company_entity_id, location_name);
