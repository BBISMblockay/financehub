/* ========================================================================
   SILO avatar — shared render + upload helper.
   Pairs with the .bcn-avatar component in beacon.css and the `avatars`
   Supabase Storage bucket (supabase/migrations/20260805050000_profile_avatars.sql).

   Include after beacon.css, before any page script that renders avatars:
     <script src="avatar.js"></script>

   Render:
     SiloAvatar.html({ name, email, avatarUrl }, 'sm', 'extra-class')  -> HTML string
     (size: 'xs'|'sm'|'md'|'lg', default 'sm'; extraClass is optional)

   Upload (self-service, current signed-in user only — storage policy
   enforces the folder-per-user boundary regardless of what path is passed):
     await SiloAvatar.upload(supabaseClient, userId, file)  -> public URL
   ======================================================================== */
(function (global) {
  function initials(name, email) {
    const n = String(name || '').trim();
    if (n) return n.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
    const e = String(email || '').trim();
    return e ? e[0].toUpperCase() : '?';
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function html(person, size, extraClass) {
    const p = person || {};
    const cls = ['bcn-avatar', 'bcn-avatar--' + (size || 'sm'), extraClass || ''].filter(Boolean).join(' ');
    const label = escAttr(p.name || p.email || 'User');
    if (p.avatarUrl) {
      return `<span class="${cls}" style="background-image:url('${escAttr(p.avatarUrl)}')" role="img" aria-label="${label}"></span>`;
    }
    return `<span class="${cls}" aria-hidden="true">${escAttr(initials(p.name, p.email))}</span>`;
  }

  const MAX_BYTES = 5 * 1024 * 1024;
  const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

  async function upload(supabaseClient, userId, file) {
    if (!supabaseClient || !userId || !file) throw new Error('Missing client, user, or file.');
    if (!ALLOWED_TYPES.includes(file.type)) throw new Error('Use a JPEG, PNG, or WEBP image.');
    if (file.size > MAX_BYTES) throw new Error('Image is larger than 5MB.');

    const ext = (file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg');
    const path = `${userId}/avatar.${ext}`;

    const { error: upErr } = await supabaseClient.storage
      .from('avatars')
      .upload(path, file, { upsert: true, contentType: file.type });
    if (upErr) throw upErr;

    const { data } = supabaseClient.storage.from('avatars').getPublicUrl(path);
    const publicUrl = data?.publicUrl;
    if (!publicUrl) throw new Error('Upload succeeded but no public URL was returned.');

    // Cache-bust so the browser doesn't keep showing a stale cached image
    // after re-uploading to the same path (upsert overwrites the same file).
    return `${publicUrl}?v=${Date.now()}`;
  }

  global.SiloAvatar = { html, initials, upload };
})(window);
