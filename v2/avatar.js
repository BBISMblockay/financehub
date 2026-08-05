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
   iPhone HEIC photos are auto-converted to JPEG in-browser first (lazy-
   loads heic2any from a CDN only when a HEIC file is actually seen), since
   HEIC uploads fine but doesn't render in non-Safari browsers.
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
  const HEIC_URL = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';

  // iPhones save camera-roll photos as HEIC by default. Safari's file
  // picker hands that File over as-is (type "image/heic", or sometimes ""
  // — Safari doesn't always fill in the MIME type for HEIC), and no
  // non-Safari browser can display it. Detect it by type OR extension and
  // convert to JPEG client-side before it ever reaches Storage, so what's
  // actually stored is always viewable everywhere.
  function looksLikeHeic(file) {
    const type = String(file.type || '').toLowerCase();
    if (type === 'image/heic' || type === 'image/heif') return true;
    if (type) return false; // a real, non-HEIC type was reported — trust it
    return /\.heic$|\.heif$/i.test(file.name || '');
  }

  let heicLoad = null;
  function loadHeic2any() {
    if (window.heic2any) return Promise.resolve(window.heic2any);
    if (heicLoad) return heicLoad;
    heicLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HEIC_URL;
      s.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error('heic2any failed to load.')));
      s.onerror = () => reject(new Error('Could not load the HEIC image converter (check your connection).'));
      document.head.appendChild(s);
    });
    return heicLoad;
  }

  async function convertHeicToJpeg(file) {
    const heic2any = await loadHeic2any();
    const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
    const jpegBlob = Array.isArray(result) ? result[0] : result;
    return new File([jpegBlob], (file.name || 'avatar').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  }

  async function upload(supabaseClient, userId, file) {
    if (!supabaseClient || !userId || !file) throw new Error('Missing client, user, or file.');
    if (file.size > MAX_BYTES) throw new Error('Image is larger than 5MB.');

    if (looksLikeHeic(file)) {
      try {
        file = await convertHeicToJpeg(file);
      } catch (e) {
        throw new Error('Could not convert this iPhone photo (HEIC). ' + (e.message || 'Try "Save as JPEG" or a different photo.'));
      }
    }

    if (!ALLOWED_TYPES.includes(file.type)) throw new Error('Use a JPEG, PNG, or WEBP image.');

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
