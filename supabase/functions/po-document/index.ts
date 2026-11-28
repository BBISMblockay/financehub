// po-document -- one purchase order as a PDF, for the Download button in SILO
// and for an AI connection to attach to the email it sends from the person's
// own mailbox. Deployed with verify_jwt OFF (see handler.mjs for why, and for
// the two ways in). The service role is used only to resolve a single-use
// document token to its purchase order.
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { createPoDocumentHandler } from './handler.mjs';
import { renderPurchaseOrder, identity } from './render.mjs';

const handle = createPoDocumentHandler({
  env: {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  },
  fetchImpl: fetch,
  pdfLib: { PDFDocument, StandardFonts, rgb },
  renderPurchaseOrder,
  identity,
  cryptoImpl: crypto,
});

Deno.serve(handle);
