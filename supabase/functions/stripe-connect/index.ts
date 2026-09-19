// Thin by design: the handler lives in handler.ts so it can be driven from
// node (scripts/tests/stripe-handlers.test.mjs) without a Deno runtime. The
// same split plaid-finance uses, and for the same reason -- an orchestrator
// no test ever executes is where this repo has shipped a dead-zone reference
// before, with the core it calls sitting on 91 passing assertions.
import { handleStripeConnect } from './handler.ts';

Deno.serve(handleStripeConnect);
