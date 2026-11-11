// affiliate-research -- JWT-auth "Find creators with AI" and "Import a list"
// for Affiliate Studio. See handler.mjs.
//
// Secrets: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY
// (the same key Ask SILO uses), DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD (optional). AFFILIATE_RESEARCH_MODEL optionally overrides
// the model; it must have a row in ai_provider_rates or metered workspaces
// refuse it.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createResearchHandler } from './handler.mjs';

const url = Deno.env.get('SUPABASE_URL')!;
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// Research takes minutes: the request answers 202 at once and the work keeps
// running after the response, up to the platform's background wall clock.
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;

Deno.serve(createResearchHandler({
  service,
  userClientFor: (authHeader: string) => createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
  // Google leads for each run (the same search account Affiliate Studio's
  // saved searches use); without them research runs on the AI's own searches.
  serpCredentials: { login: Deno.env.get('DATAFORSEO_LOGIN') ?? '', password: Deno.env.get('DATAFORSEO_PASSWORD') ?? '' },
  model: Deno.env.get('AFFILIATE_RESEARCH_MODEL') || 'claude-sonnet-5-5',
  // SILO opens creators' own profile pages for their photo (lib/affiliate-photo-core.mjs).
  photoFetch: fetch,
  background: (p: Promise<unknown>) => { if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(p); },
}));
