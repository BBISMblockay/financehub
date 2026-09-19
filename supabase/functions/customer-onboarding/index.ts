// Thin by design: the handler lives in handler.ts so it can be driven from
// node (scripts/tests/customer-onboarding.test.mjs) without a Deno runtime.
// The same split stripe-invoice and plaid-finance use.
import { handleCustomerOnboarding } from './handler.ts';

Deno.serve(handleCustomerOnboarding);
