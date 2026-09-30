// Mirrors server gates for a workspace member row on settings-team.html.
// Keep in sync with is_exec_or_owner() and can_manage_journal_entries() in
// supabase/migrations/20260714210000_per_company_roles.sql and
// supabase/migrations/20260831180000_card_coding.sql — evaluated for the
// TARGET's membership in the active workspace, not auth.uid().
(function (root) {
  const profileRole = (p) => String(p?.role || '').toLowerCase();

  /** Same predicate as is_exec_or_owner(), for a target user in this workspace. */
  function targetIsExecOrOwner(membershipRole, profile) {
    const active = profile?.is_active !== false;
    if (!active) return false;
    const mr = membershipRole != null && membershipRole !== '' ? String(membershipRole) : null;
    const pr = profileRole(profile);
    if (mr != null) {
      return mr === 'owner_admin' || pr === 'executive';
    }
    return pr === 'owner' || pr === 'executive';
  }

  /** Same predicate as can_manage_journal_entries(), for a target in this workspace. */
  function targetHasFinanceAccess(membershipRole, profile) {
    const active = profile?.is_active !== false;
    if (!active) return false;
    const mr = membershipRole != null && membershipRole !== '' ? String(membershipRole) : null;
    const pr = profileRole(profile);
    const ownerPass = mr != null ? mr === 'owner_admin' : pr === 'owner';
    const dept = String(profile?.department || '').toLowerCase();
    return ownerPass || dept === 'finance' || dept === 'exec';
  }

  /** Finance access that cannot be revoked from this page (membership owner_admin). */
  function financeInheritedFromWorkspace(membershipRole, profile) {
    const active = profile?.is_active !== false;
    if (!active) return false;
    const mr = membershipRole != null && membershipRole !== '' ? String(membershipRole) : null;
    return mr === 'owner_admin';
  }

  function departmentChangeBlocked(hasOtherOrgMembership) {
    return !!hasOtherOrgMembership;
  }

  root.SiloTeamFeatureAccess = {
    profileRole,
    targetIsExecOrOwner,
    targetHasFinanceAccess,
    financeInheritedFromWorkspace,
    departmentChangeBlocked,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
