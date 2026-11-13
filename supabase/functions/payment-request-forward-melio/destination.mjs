/**
 * Where a company's approved payment request is forwarded, from that company's
 * own settings and nothing else.
 *
 * There used to be a fallback here: with no provider and no email configured,
 * a company whose entity_key was 'baseballism' inherited a legacy Melio inbox
 * from the MELIO_FORWARD_EMAIL secret. It was removed on 2026-11-13 as
 * company-specific logic in shared code -- and it was already dead, because
 * that company's company_settings row carries both bill_pay_provider = 'melio'
 * and bill_pay_forward_email, so the first branch below has been the answer
 * for every call. An unconfigured company now gets null, which the caller
 * turns into "set the bill pay provider and inbox email in Workspace
 * Settings", the same message every other company already got.
 *
 * @param {{ bill_pay_provider: string | null, bill_pay_forward_email: string | null } | null} settings
 * @returns {{ provider: 'melio' | 'bill', email: string } | null}
 */
export function resolveBillPayDestination(settings) {
  const provider = settings?.bill_pay_provider;
  const email = settings?.bill_pay_forward_email?.trim();
  if ((provider === 'melio' || provider === 'bill') && email) return { provider, email };
  return null;
}
