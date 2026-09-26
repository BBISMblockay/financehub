/**
 * @param {{ bill_pay_provider: string | null, bill_pay_forward_email: string | null } | null} settings
 * @param {string | null} entityKey
 * @param {string} legacyMelioEmail
 * @returns {{ provider: 'melio' | 'bill', email: string } | null}
 */
export function resolveBillPayDestination(settings, entityKey, legacyMelioEmail) {
  const provider = settings?.bill_pay_provider;
  const email = settings?.bill_pay_forward_email?.trim();
  if ((provider === 'melio' || provider === 'bill') && email) return { provider, email };
  // The old secret belongs only to Baseballism. An unconfigured tenant must
  // never inherit it, and a configured BILL tenant must never fall back to it.
  if (!provider && !email && entityKey === 'baseballism' && legacyMelioEmail) {
    return { provider: 'melio', email: legacyMelioEmail };
  }
  return null;
}
