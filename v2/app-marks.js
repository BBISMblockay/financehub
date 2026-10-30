/* Marks for the outside AI applications SILO connects to.
 *
 * Drawn here as inline SVG rather than fetched from each vendor, because a
 * settings page must render with no third-party request: a logo CDN that is
 * slow, blocked or gone would leave holes in the one screen whose job is to
 * look trustworthy. They are simplified, monochrome-ish marks in each app's
 * own colour -- enough to recognise the row at a glance, not a reproduction.
 *
 * An application nobody here has a mark for gets a LETTER badge built from its
 * own name. That is deliberate: a wrong logo beside someone's live connection
 * is worse than no logo, and the badge still gives the row something to scan.
 *
 * Used by v2/settings-connect-ai.html.
 * window.SiloAppMarks.svg(key) -> markup; .keyForName(name) -> key or null.
 */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MARKS = {
    // Anthropic's burst, as four rounded spokes.
    claude: {
      tint: '#D97757',
      body: '<g stroke="currentColor" stroke-width="2.6" stroke-linecap="round">'
        + '<line x1="12" y1="3.5" x2="12" y2="20.5"/>'
        + '<line x1="3.5" y1="12" x2="20.5" y2="12"/>'
        + '<line x1="6" y1="6" x2="18" y2="18"/>'
        + '<line x1="18" y1="6" x2="6" y2="18"/></g>',
    },
    // A terminal: the same burst would say nothing about where it runs.
    'claude-code': {
      tint: '#D97757',
      body: '<rect x="2.5" y="4" width="19" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/>'
        + '<polyline points="7,10 10,12.5 7,15" fill="none" stroke="currentColor" stroke-width="1.8"'
        + ' stroke-linecap="round" stroke-linejoin="round"/>'
        + '<line x1="12.5" y1="15" x2="17" y2="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    },
    // A knot, read as a hexagon with a linked interior.
    chatgpt: {
      tint: '#10A37F',
      body: '<polygon points="12,2.6 20.1,7.3 20.1,16.7 12,21.4 3.9,16.7 3.9,7.3" fill="none"'
        + ' stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>'
        + '<path d="M8.2 9.6 12 11.8l3.8-2.2M12 11.8v4.4" fill="none" stroke="currentColor"'
        + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    },
    // A cube, which is what Cursor's own mark reads as at this size.
    cursor: {
      tint: '#6E56CF',
      body: '<path d="M12 2.8 20.6 7.6v9.6L12 21.2 3.4 17.2V7.6z" fill="none" stroke="currentColor"'
        + ' stroke-width="1.7" stroke-linejoin="round"/>'
        + '<path d="M3.4 7.6 12 12.4l8.6-4.8M12 12.4v8.8" fill="none" stroke="currentColor"'
        + ' stroke-width="1.7" stroke-linejoin="round"/>',
    },
    // The folded ribbon.
    vscode: {
      tint: '#0098FF',
      body: '<path d="M17.4 3.2 9.1 11 4.9 7.9 3 9l3.6 3L3 15l1.9 1.1L9.1 13l8.3 7.8L21 19V5z"'
        + ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    },
    // xAI's angular X.
    grok: {
      tint: '',
      body: '<g stroke="currentColor" stroke-width="2.2" stroke-linecap="round">'
        + '<line x1="4.5" y1="4.5" x2="19.5" y2="19.5"/>'
        + '<line x1="19.5" y1="4.5" x2="13.2" y2="10.8"/>'
        + '<line x1="10.8" y1="13.2" x2="4.5" y2="19.5"/></g>',
    },
    // Anything else that speaks MCP.
    generic: {
      tint: '',
      body: '<path d="M9 7V4M15 7V4M7 7h10v4a5 5 0 0 1-10 0z" fill="none" stroke="currentColor"'
        + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="M12 16v4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    },
  };

  /* Longest, most specific first: "Claude Code" must not match on "claude",
     and "VS Code" must not be caught by a bare "code". */
  const NAME_RULES = [
    [/claude\s*code|claude-code/i, 'claude-code'],
    [/\bclaude\b|anthropic/i, 'claude'],
    [/chatgpt|openai/i, 'chatgpt'],
    [/\bcursor\b/i, 'cursor'],
    [/vs\s*code|visual studio code|vscode/i, 'vscode'],
    [/\bgrok\b|\bxai\b/i, 'grok'],
  ];

  function keyForName(name) {
    const s = String(name || '');
    for (const [re, key] of NAME_RULES) if (re.test(s)) return key;
    return null;
  }

  function svg(key, size) {
    const m = MARKS[key] || MARKS.generic;
    const px = size || 24;
    return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" aria-hidden="true"'
      + ' focusable="false"' + (m.tint ? ' style="color:' + m.tint + '"' : '') + '>' + m.body + '</svg>';
  }

  /* The fallback for an application with no mark: its own initial. Never a
     guessed logo. */
  function letterBadge(name) {
    const ch = (String(name || '?').trim()[0] || '?').toUpperCase();
    return '<span class="app-mark-letter" aria-hidden="true">' + esc(ch) + '</span>';
  }

  /** A mark for an application known only by name: its logo, or its initial. */
  function forName(name, size) {
    const key = keyForName(name);
    return key ? svg(key, size) : letterBadge(name);
  }

  window.SiloAppMarks = { svg, forName, keyForName, letterBadge, MARKS };
})();
