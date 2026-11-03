// MCP server for SILO's developer platform. Deployed with verify_jwt OFF: it
// verifies callers itself, so an MCP client's first, token-less request gets
// the 401 + WWW-Authenticate that tells it where to sign in. It never uses the
// database service role. Live source reads are authorized by caller-token
// PostgREST before using the Windsor key; all returned identities are checked.
// Logic and the reasons for each of those choices in handler.mjs.
import { createMcpHandler } from './handler.mjs';

const handle = createMcpHandler({
  env: {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
    WINDSOR_API_KEY: Deno.env.get('WINDSOR_API_KEY'),
    // Optional: the URL clients are told to use, if it is ever served from a
    // custom domain. Defaults to <SUPABASE_URL>/functions/v1/mcp.
    SILO_MCP_PUBLIC_URL: Deno.env.get('SILO_MCP_PUBLIC_URL'),
    // Optional override of the OAuth issuer clients are sent to. Defaults to
    // <SUPABASE_URL>/auth/v1, also on a custom domain. See handler.mjs.
    SILO_MCP_ISSUER: Deno.env.get('SILO_MCP_ISSUER'),
  },
  fetchImpl: fetch,
});

Deno.serve(handle);
