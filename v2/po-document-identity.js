/* What a company's outbound purchase order says about the company.

   PRESENTATION LOGIC ONLY, and deliberately not inline in po-builder.html:
   that page printed "Baseballism Inc.", a Beaverton address and a named buyer
   as literals for every tenant until 2026-09-22, and the rule for what to
   print instead is worth a test. Reads company_settings (legal_name,
   ship-to columns, purchasing_contact_*), entities.title and the generating
   user's profile; never Supabase directly.

   Fallbacks are honest, never invented: no legal name -> the company title;
   no purchasing contact -> the person generating the PO; no address -> the
   block is EMPTY and `missing` names it, so the page can say "not configured"
   before the PDF opens. Nothing here ever prints another tenant's details. */
(function (root) {
  const SETTINGS_COLUMNS = 'legal_name, address_line1, address_line2, city, region, postal_code, country, phone, purchasing_contact_name, purchasing_contact_phone, purchasing_contact_email';
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  function resolve({ settings, entity, user } = {}) {
    const s = settings || {}, e = entity || {}, u = user || {};
    const missing = [];
    const name = clean(s.legal_name) || clean(e.title);
    if (!name) missing.push('company name');
    const cityLine = [clean(s.city), [clean(s.region), clean(s.postal_code)].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    const address = [clean(s.address_line1), clean(s.address_line2), cityLine, clean(s.country)].filter(Boolean);
    if (!address.length) missing.push('ship-to address');
    let contact = [clean(s.purchasing_contact_name), clean(s.purchasing_contact_phone), clean(s.purchasing_contact_email)].filter(Boolean);
    let contactSource = 'settings';
    if (!contact.length) {
      contact = [clean(u.name), clean(u.email)].filter(Boolean);
      contactSource = contact.length ? 'user' : 'none';
    }
    if (!contact.length) missing.push('buyer contact');
    return {
      name,
      shipTo: name ? [name, ...address] : address,
      contact,
      contactSource,
      phone: clean(s.phone),
      footer: name ? `${name} Purchase Order` : 'Purchase Order',
      missing,
    };
  }

  const api = { SETTINGS_COLUMNS, resolve };
  if (root) root.SiloPoDocumentIdentity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
