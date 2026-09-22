import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Legacy shared Slack delivery is intentionally paused. The former deployed
// version embedded a Baseballism webhook and accepted unauthenticated requests.
// Keep this inert endpoint until Slack returns as an explicit per-workspace
// OAuth integration with tenant channel mappings and preferences.
Deno.serve(() => new Response(
  JSON.stringify({ ok: false, disabled: true, reason: "legacy_slack_paused" }),
  { status: 410, headers: { "Content-Type": "application/json" } },
));
