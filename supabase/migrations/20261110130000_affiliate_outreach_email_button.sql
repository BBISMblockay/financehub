-- The join button in outreach email shows in Gmail, with a plain link under it.
--
-- WHY. Blake, 2026-11-10, first branded send (Claude + Gmail): the email came
-- through with a blank gap where the "See the program and join" button should
-- be -- "working but tough ui ux". The 20261110110000 button was a styled
-- <a> inside a <p>; somewhere between the AI's mail tool and Gmail's
-- sanitiser it was dropped, and there was no other way to reach the link.
--
-- WHAT CHANGES. affiliate_outreach_html() only (silo_api_claim_outreach is
-- unchanged and still calls it):
--   * the button is the email-safe form: a one-cell table whose cell carries
--     the background colour (bgcolor attribute and style), with the link
--     inside -- the pattern mail clients that strip CSS still draw;
--   * under it, always, "Or open this link:" and the link itself as visible
--     text, so even a client that removes every <a> leaves an address a
--     person can copy;
--   * the layout is tables with inline styles throughout (no <div> layout),
--     with the company's initial as a badge next to its name.
-- The message text is still the approved draft, escaped character by
-- character; only the URL SILO minted goes into an href, escaped too.

create or replace function public.affiliate_outreach_html(p_brand text, p_body text, p_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_marker constant text := chr(1);   -- stripped from the draft first, so only the link position carries it
  c_p      constant text := '<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#14181d">';
  v_body   text := replace(coalesce(p_body, ''), chr(1), '');
  v_esc    text;
  v_btn    text;
  v_paras  text := '';
  v_p      text;
  v_url    text := replace(replace(replace(replace(coalesce(p_url, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  v_name   text := coalesce(nullif(btrim(p_brand), ''), 'Affiliate program');
  v_brand  text;
  v_init   text;
begin
  v_brand := replace(replace(replace(replace(v_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  v_init  := replace(replace(replace(replace(upper(left(v_name, 1)), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  v_body := replace(v_body, E'\r\n', E'\n');
  if position('{signup_link}' in v_body) > 0 then
    v_body := replace(v_body, '{signup_link}', c_marker);
  else
    v_body := v_body || E'\n\n' || c_marker;
  end if;
  v_esc := replace(replace(replace(replace(v_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
  v_btn := '</p>'
    || '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 10px"><tr>'
    || '<td bgcolor="#14181d" style="background:#14181d;border-radius:8px;padding:0">'
    || '<a href="' || v_url || '" target="_blank" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:8px">See the program and join &rarr;</a>'
    || '</td></tr></table>'
    || '<p style="margin:0 0 18px;font-size:12px;line-height:1.5;color:#77828d">Or open this link: '
    || '<a href="' || v_url || '" target="_blank" style="color:#2f5fd0;word-break:break-all">' || v_url || '</a></p>'
    || c_p;
  foreach v_p in array regexp_split_to_array(v_esc, E'\n\\s*\n') loop
    if btrim(v_p) = '' then continue; end if;
    v_paras := v_paras || c_p || replace(replace(btrim(v_p, E'\n'), E'\n', '<br>'), c_marker, v_btn) || '</p>' || E'\n';
  end loop;
  -- A button that ends a paragraph leaves an empty one behind; drop it.
  v_paras := replace(v_paras, c_p || '</p>', '');
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f5f7" style="background:#f4f5f7"><tr><td align="center" style="padding:28px 12px">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:-apple-system,''Segoe UI'',Roboto,Helvetica,Arial,sans-serif">'
    || '<tr><td style="padding:0 4px 14px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    || '<td width="32" height="32" align="center" bgcolor="#14181d" style="background:#14181d;border-radius:8px;color:#ffffff;font-weight:700;font-size:15px;width:32px;height:32px">' || v_init || '</td>'
    || '<td style="padding-left:10px;font-weight:700;font-size:16px;color:#14181d">' || v_brand || '</td>'
    || '</tr></table></td></tr>'
    || '<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid #e2e6ea;border-radius:12px;padding:26px 26px 12px">' || E'\n'
    || v_paras
    || '</td></tr>'
    || '<tr><td style="padding:14px 4px 0;font-size:12px;line-height:1.5;color:#77828d">' || v_brand || ' affiliate program, powered by SILO</td></tr>'
    || '</table></td></tr></table></body></html>';
end;
$$;

comment on function public.affiliate_outreach_html(text, text, text) is
  'Branded HTML for one approved affiliate outreach message: company initial and name, the escaped message, an email-safe table button where {signup_link} was (or at the end) with the link also shown as text under it. Internal to silo_api_claim_outreach. 20261110110000, button 20261110130000.';

revoke all on function public.affiliate_outreach_html(text, text, text)
  from public, anon, authenticated, silo_integration, silo_revoked;
