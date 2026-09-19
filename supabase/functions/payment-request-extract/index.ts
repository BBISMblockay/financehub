import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { createHandler } from './handler.mjs';

// Caller-scoped reads only. No service key, remote document URLs or DB writes.
Deno.serve(createHandler({
  makeClient: createClient,
  env: (name: string) => Deno.env.get(name) || '',
}));
