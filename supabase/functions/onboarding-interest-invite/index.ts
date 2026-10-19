import { createHandler } from './handler.ts';

Deno.serve(createHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL'),
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  enabled: Deno.env.get('ONBOARDING_AUTO_INVITE') === 'true',
  dailyCap: Number(Deno.env.get('ONBOARDING_AUTO_INVITE_DAILY_CAP') || 100),
  resendKey: Deno.env.get('RESEND_API_KEY') || '',
  mailFrom: Deno.env.get('SILO_MAIL_FROM') || undefined,
  siteUrl: Deno.env.get('SILO_SITE_URL') || undefined,
}));
