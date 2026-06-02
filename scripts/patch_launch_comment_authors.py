#!/usr/bin/env python3
"""Show comment author on launch calendar comments."""

from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "v2" / "launch-calendar.html"
t = PATH.read_text(encoding="utf-8")

COMMENT_CSS = """
    /* launch comments — author attribution */
    .comment-compose-hint { font-size: 11px; color: var(--bcn-ink-3); margin: 0 0 8px; }
    .comment-card {
      border: 1px solid var(--bcn-border);
      border-radius: 10px;
      background: var(--bcn-surface);
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .comment-card--mine { background: oklch(0.97 0.01 245); border-color: var(--bcn-accent-border, var(--bcn-border)); }
    .comment-card__head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .comment-card__avatar {
      width: 32px; height: 32px; border-radius: 9px; flex-shrink: 0;
      display: grid; place-items: center;
      font-family: var(--bcn-mono); font-size: 11px; font-weight: 700;
      background: var(--bcn-band); color: #fff;
    }
    .comment-card--mine .comment-card__avatar { background: var(--bcn-accent); }
    .comment-card__who { flex: 1; min-width: 0; }
    .comment-card__author { display: block; font-size: 12px; font-weight: 700; color: var(--bcn-ink); line-height: 1.2; }
    .comment-card__email { display: block; font-size: 10px; color: var(--bcn-ink-3); margin-top: 1px; }
    .comment-card__time { font-size: 10px; font-family: var(--bcn-mono); color: var(--bcn-ink-4, var(--bcn-ink-3)); white-space: nowrap; }
    .comment-card__body { font-size: 13px; line-height: 1.45; color: var(--bcn-ink); white-space: pre-wrap; }
"""

if "comment-card__author" not in t:
    t = t.replace(
        "    .dp-item-meta { font-size:11px; color:var(--bcn-ink-3); margin-top:2px; white-space:pre-wrap; }",
        "    .dp-item-meta { font-size:11px; color:var(--bcn-ink-3); margin-top:2px; white-space:pre-wrap; }\n" + COMMENT_CSS,
    )

t = t.replace(
    """        <form id="commentForm">
          <div class="bcn-field-group"><textarea class="bcn-field" id="commentInput" rows="3" placeholder="Add a comment…" required></textarea></div>
          <div style="display:flex;justify-content:flex-end;margin-top:8px;"><button class="bcn-btn bcn-btn--primary bcn-btn--mono">POST COMMENT</button></div>
        </form>""",
    """        <form id="commentForm">
          <p class="comment-compose-hint" id="commentComposeHint">Posting as …</p>
          <div class="bcn-field-group"><textarea class="bcn-field" id="commentInput" rows="3" placeholder="Add a comment…" required></textarea></div>
          <div style="display:flex;justify-content:flex-end;margin-top:8px;"><button class="bcn-btn bcn-btn--primary bcn-btn--mono">POST COMMENT</button></div>
        </form>""",
)

t = t.replace(
    """  const COMMENTS = [
    { id:1, launch_id:2, comment:"Assets still needed from Owen — chasing.", created_at:new Date(Date.now()-7200000).toISOString() },
    { id:2, launch_id:5, comment:"Launched clean. Sales tracking strong.",    created_at:new Date(Date.now()-172800000).toISOString() },
  ];""",
    """  const COMMENTS = [
    { id:1, launch_id:2, user_id:'demo', comment:"Assets still needed from Owen — chasing.", created_at:new Date(Date.now()-7200000).toISOString() },
    { id:2, launch_id:5, user_id:'demo-owen', comment:"Launched clean. Sales tracking strong.", created_at:new Date(Date.now()-172800000).toISOString() },
  ];""",
)

if "let profileById" not in t:
    t = t.replace(
        "let currentUser = null;\nlet launches=",
        "let currentUser = null;\nlet profileById = new Map();\nlet launches=",
    )

HELPERS = r'''
function profileInitialsFrom(name, email) {
  const n = String(name || '').trim();
  if (n) return n.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  const e = String(email || '').trim();
  return e ? e[0].toUpperCase() : '?';
}

function commentUserId(c) {
  return c?.user_id || c?.created_by || c?.author_id || null;
}

function commentAuthorInfo(c) {
  const uid = commentUserId(c);
  if (currentUser && uid && uid === currentUser.id) {
    const meta = currentUser.user_metadata || {};
    const email = currentUser.email || '';
    const name = meta.full_name || meta.name || email.split('@')[0] || 'You';
    return { label: 'You', email, initials: profileInitialsFrom(name, email), isYou: true };
  }
  if (c?.author_name) {
    return { label: c.author_name, email: c.author_email || '', initials: profileInitialsFrom(c.author_name, c.author_email), isYou: false };
  }
  if (uid && profileById.has(uid)) {
    const p = profileById.get(uid);
    const email = p.email || '';
    const name = p.name || p.full_name || email.split('@')[0] || 'Team member';
    return { label: name, email, initials: profileInitialsFrom(name, email), isYou: false };
  }
  if (c?.user_email) {
    const email = c.user_email;
    return { label: email.split('@')[0], email, initials: profileInitialsFrom('', email), isYou: false };
  }
  return { label: 'Team member', email: '', initials: '?', isYou: false };
}

function updateCommentComposeHint() {
  const el = $('commentComposeHint');
  if (!el) return;
  if (!currentUser) { el.textContent = ''; return; }
  const meta = currentUser.user_metadata || {};
  const name = meta.full_name || meta.name || currentUser.email || 'You';
  el.textContent = 'Posting as ' + name;
}

async function loadProfiles() {
  profileById = new Map();
  try {
    const { data, error } = await db.from('profiles').select('id, name, email, full_name').limit(5000);
    if (!error && data) data.forEach(p => profileById.set(p.id, p));
  } catch (e) { /* profiles optional */ }
}
'''

if "function commentAuthorInfo" not in t:
    t = t.replace("async function loadAll(shouldRender=true){", HELPERS + "\nasync function loadAll(shouldRender=true){")

OLD_LOAD = """async function loadAll(shouldRender=true){
  const [l,t,a,c,s,ch,p] = await Promise.all([
    db.from('launch_calendar').select('*').order('launch_date',{ascending:true}),
    db.from('launch_tasks').select('*').order('created_at',{ascending:false}),
    db.from('launch_assets').select('*').order('created_at',{ascending:false}),
    db.from('launch_comments').select('*').order('created_at',{ascending:false}),
    db.from('launch_system_links').select('*').order('created_at',{ascending:false}),
    db.from('launch_channel_items').select('*').order('scheduled_date',{ascending:true}),
    db.from('launch_product_readiness').select('*').order('created_at',{ascending:false}),
  ]);"""

NEW_LOAD = """async function loadAll(shouldRender=true){
  await loadProfiles();
  updateCommentComposeHint();
  const [l,t,a,c,s,ch,p] = await Promise.all([
    db.from('launch_calendar').select('*').order('launch_date',{ascending:true}),
    db.from('launch_tasks').select('*').order('created_at',{ascending:false}),
    db.from('launch_assets').select('*').order('created_at',{ascending:false}),
    db.from('launch_comments').select('*').order('created_at',{ascending:true}),
    db.from('launch_system_links').select('*').order('created_at',{ascending:false}),
    db.from('launch_channel_items').select('*').order('scheduled_date',{ascending:true}),
    db.from('launch_product_readiness').select('*').order('created_at',{ascending:false}),
  ]);"""

if OLD_LOAD in t:
    t = t.replace(OLD_LOAD, NEW_LOAD)

OLD_RENDER = """function renderComments(rows){
  $('commentList').innerHTML=rows.length?'':empStr('No comments yet.');
  rows.forEach(c=>{
    const div=document.createElement('div'); div.className='dp-item';
    div.innerHTML=`<div><div style="font-size:13px;">${esc(c.comment)}</div><div class="dp-item-meta">${new Date(c.created_at).toLocaleString()}</div></div>`;
    $('commentList').appendChild(div);
  });
}"""

NEW_RENDER = """function renderComments(rows){
  $('commentList').innerHTML=rows.length?'':empStr('No comments yet.');
  const sorted = rows.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  sorted.forEach(c => {
    const who = commentAuthorInfo(c);
    const when = c.created_at ? new Date(c.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const div = document.createElement('div');
    div.className = 'comment-card' + (who.isYou ? ' comment-card--mine' : '');
    div.innerHTML = `
      <div class="comment-card__head">
        <span class="comment-card__avatar" aria-hidden="true">${esc(who.initials)}</span>
        <span class="comment-card__who">
          <span class="comment-card__author">${esc(who.label)}</span>
          ${who.email && !who.isYou ? `<span class="comment-card__email">${esc(who.email)}</span>` : ''}
        </span>
        <time class="comment-card__time" datetime="${esc(c.created_at || '')}">${esc(when)}</time>
      </div>
      <div class="comment-card__body">${esc(c.comment)}</div>`;
    $('commentList').appendChild(div);
  });
}"""

if OLD_RENDER in t:
    t = t.replace(OLD_RENDER, NEW_RENDER)

OLD_SAVE = """  const payload={ launch_id:activeLaunch.id, user_id:currentUser.id, comment:$('commentInput').value.trim() };"""

NEW_SAVE = """  const payload={
    launch_id: activeLaunch.id,
    user_id: currentUser.id,
    created_by: currentUser.id,
    comment: $('commentInput').value.trim(),
  };"""

if OLD_SAVE in t:
    t = t.replace(OLD_SAVE, NEW_SAVE)

if "updateCommentComposeHint();" not in t.split("currentUser = data.user")[1].split("bind();")[0]:
    t = t.replace(
        "  currentUser = data.user;\n\n  if(window.SiloChrome){",
        "  currentUser = data.user;\n  updateCommentComposeHint();\n\n  if(window.SiloChrome){",
    )

PATH.write_text(t, encoding="utf-8")
print("patched", PATH)
