-- Followers becomes its own campaign objective, separate from Subscribers.
--
-- Sammie named four objectives for the paid-media read: Purchases, Thruplays,
-- Subscribers and Followers. SILO had three, because meta_campaign_group()
-- matched 'follower' inside the SUBSCRIBERS branch -- so every follower buy
-- was reported as a subscriber buy.
--
-- That was already known to be wrong, and worked around rather than fixed: the
-- subscribers group carries a `spend_without_leads` figure and the report says
-- "a followers buy reports `follow`, never `lead`. Their spend is excluded
-- from the rate's numerator". The exclusion existed precisely because the
-- wrong campaigns were in the group. Splitting them out is the actual fix; the
-- exclusion stays for anything else that genuinely reports no leads.
--
-- The new branch sits ABOVE subscribers (first match wins) and BELOW thruplay,
-- so a video-views campaign with "followers" in its name still reads as
-- thruplay -- the buying objective, not the noun in the title.
--
-- Verified against every distinct meta campaign name in both
-- marketing_kpis_daily and meta_ad_performance_daily before applying: exactly
-- three move, and all three are follower buys --
--   '1 - Instagram Followers', 'IG Followers',
--   'Instagram Followers 12/30 Activation'
-- Every other campaign keeps the group it had. 'Subscribers' and
-- 'Subscribers - Instant Forms Only' stay subscribers.
--
-- \mfollowers?\M is word-bounded on purpose: an unanchored 'follow' would
-- catch a "Follow Up" or "Following" campaign and quietly move it.

create or replace function public.meta_campaign_group(p_name text)
returns text language sql immutable as $$
  select case
    when coalesce(p_name,'') ~* '(thru.?play|video.?view|upper.?funnel|awareness|brand.?promotion)' then 'thruplay'
    when coalesce(p_name,'') ~* '\mfollowers?\M'                                                    then 'followers'
    when coalesce(p_name,'') ~* '(subscriber|follower|sign.?up|opt.?in|\msms\M|email|activation|\mlead)' then 'subscribers'
    when coalesce(p_name,'') ~* '(traffic|landing.?page|link.?click|\mlpv\M|page.?view)'            then 'traffic'
    when coalesce(p_name,'') ~* '(purchase|conversion|\msale|catalog|dpa|retarget|prospect|advantage)' then 'purchase'
    else 'other'
  end;
$$;

comment on function public.meta_campaign_group(text) is
  'Maps a Meta campaign name to its buying objective: thruplay | followers | subscribers | traffic | purchase | other. Followers is matched before subscribers and word-bounded -- a follower buy reports follows, never leads, so grouping it with subscribers made the subscribers cost-per-lead meaningless. Thruplay is matched first so a video-views campaign with "followers" in its name reads as the objective it was bought on.';


-- Teach wow_paid_media the new group: a label, a headline metric and a sort
-- position. Without these it renders as "Other / unclassified" judged on bare
-- spend -- which is what an unhandled group falls through to, and would look
-- like a data problem rather than a missing case.
do $mig$
declare def text; newdef text;
begin
  def := pg_get_functiondef('public.wow_paid_media(date,text)'::regprocedure);

  if position('''followers'' then ''Followers''' in def) > 0 then
    raise notice 'wow_paid_media already knows the followers group -- skipping';
    return;
  end if;

  newdef := replace(def,
    E'               ''label'', case g.grp when ''purchase'' then ''Purchase campaigns''\n'
    '                                   when ''thruplay'' then ''Thruplays / upper funnel''\n'
    '                                   when ''subscribers'' then ''Subscribers''',
    E'               ''label'', case g.grp when ''purchase'' then ''Purchase campaigns''\n'
    '                                   when ''thruplay'' then ''Thruplays / upper funnel''\n'
    '                                   when ''subscribers'' then ''Subscribers''\n'
    '                                   when ''followers'' then ''Followers''');
  if newdef = def then
    raise exception 'followers: label case not found in wow_paid_media -- refusing to guess';
  end if;

  -- Judged on spend, deliberately. A followers buy reports follows, which this
  -- sync does not carry -- so any cost-per rate would be cost per something we
  -- cannot count. Spend and reach-side volume is the honest read until the
  -- follows metric is synced.
  def := newdef;
  newdef := replace(def,
    E'               ''judged_on'', case g.grp when ''purchase'' then ''roas''\n'
    '                                       when ''thruplay'' then ''cost_per_thruplay''\n'
    '                                       when ''subscribers'' then ''cost_per_lead''',
    E'               ''judged_on'', case g.grp when ''purchase'' then ''roas''\n'
    '                                       when ''thruplay'' then ''cost_per_thruplay''\n'
    '                                       when ''subscribers'' then ''cost_per_lead''\n'
    '                                       when ''followers'' then ''spend''');
  if newdef = def then
    raise exception 'followers: judged_on case not found in wow_paid_media -- refusing to guess';
  end if;

  def := newdef;
  newdef := replace(def,
    E'             case g.grp when ''purchase'' then 1 when ''thruplay'' then 2\n'
    '                        when ''subscribers'' then 3 when ''traffic'' then 4 else 5 end ord,',
    E'             case g.grp when ''purchase'' then 1 when ''thruplay'' then 2\n'
    '                        when ''subscribers'' then 3 when ''followers'' then 4\n'
    '                        when ''traffic'' then 5 else 6 end ord,');
  if newdef = def then
    raise exception 'followers: sort case not found in wow_paid_media -- refusing to guess';
  end if;

  execute newdef;
  raise notice 'wow_paid_media now reports Followers as its own objective';
end
$mig$;
