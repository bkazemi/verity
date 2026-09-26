/**
 * The one stylesheet for every page this library serves, and for the owner page of a
 * deployment that mounts it. Served as a file rather than inlined so the pages can keep a
 * content security policy with no inline styles at all, which is also why nothing here is
 * set through a style attribute.
 *
 * These pages are records: a reader arrives at one to check a claim, reads it once, and
 * leaves. So the styling does the two things that helps with, a measured column and a
 * legible hierarchy, and nothing that would make a record look like a product.
 */
export const stylesheet = `:root {
  --ink: #23312b;
  --muted: #6b786f;
  --line: #dce2de;
  --surface: #fff;
  --raised: #f7f9f7;
  --accent: #245f43;
  color-scheme: light dark;
  accent-color: var(--accent);
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #dde5e0;
    --muted: #96a39b;
    --line: #2f3b35;
    --surface: #161a18;
    --raised: #1d2220;
    --accent: #7fc4a2;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0 1rem 4rem;
  background: var(--surface);
  color: var(--ink);
  font: 16px/1.65 system-ui, -apple-system, 'Segoe UI', sans-serif;
  text-rendering: optimizeLegibility;
}

main {
  max-width: 34rem;
  margin: 0 auto;
  padding-top: 3rem;
}

/*
 * The logotype, above the page's own heading. Sized by cap height rather than by the box
 * around it, which the descender of the y makes taller than the word looks. The word is
 * drawn in currentColor, so it takes the ink colour of whichever scheme is in use.
 */
.logo {
  display: block;
  height: 1.75rem;
  margin-bottom: 1.5rem;
}

h1 {
  margin: 0 0 1.75rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--line);
  font-size: 1.5rem;
  font-weight: 620;
  letter-spacing: -.02em;
  line-height: 1.25;
}

/*
 * A page holding one thing needs no rule under its heading. The rule divides a heading
 * from the record beneath it, and a page that only asks for a key has no record to divide.
 */
main.single h1 { margin-bottom: 1.25rem; padding-bottom: 0; border-bottom: none; }

h2 { margin: 2rem 0 .75rem; font-size: 1.125rem; font-weight: 620; letter-spacing: -.01em; }

h3 { margin: 0 0 .5rem; font-size: 1rem; font-weight: 620; }

p { margin: 0 0 1rem; overflow-wrap: break-word; }

a { color: var(--accent); text-underline-offset: 3px; overflow-wrap: anywhere; }

a:hover { text-decoration-thickness: 2px; }

/*
 * Something to be run or published exactly as written. Its own line breaks are kept and a
 * long line is soft-wrapped rather than cut off: a soft wrap is drawn, not inserted, so
 * what is copied is still character for character what was written. Selecting inside the
 * block takes all of it, since half a command is worse than none.
 */
pre {
  position: relative;
  margin: 0 0 1rem;
  /* Room along the top line for the copy button, which sits over the block rather than in it. */
  padding: .75rem 5.25rem .75rem .875rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--raised);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: all;
}

code { font: .8125rem/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }

/* Made by a script, so it exists only where it works. Quiet: the block is the point. */
.copy {
  position: absolute;
  top: .5rem;
  right: .5rem;
  padding: .1875rem .5rem;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface);
  color: var(--muted);
  font: 500 .75rem/1.5 system-ui, sans-serif;
  user-select: none;
}

.copy:hover { color: var(--ink); border-color: var(--muted); }

/*
 * The two sides of the link, which is what a reader came to read. Each fact about a side
 * gets its own line: what it is, what it is called, the identifier behind that, and how it
 * was shown. Everything else on the page qualifies the pair, so it is set quieter.
 */
.side {
  margin-bottom: .75rem;
  padding: .875rem 1rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--raised);
}

.who {
  margin: 0 0 .125rem;
  color: var(--muted);
  font-size: .75rem;
  font-weight: 550;
  letter-spacing: .02em;
}

.name { margin: 0; font-size: 1.0625rem; font-weight: 620; letter-spacing: -.01em; }

/* The name is the card's subject before it is a link, so the rule is drawn on hover. */
.name a { text-decoration: none; }

.name a:hover { text-decoration: underline; }

.reference, .how { margin: 0; color: var(--muted); font-size: .8125rem; line-height: 1.5; }

.name + .how, .reference + .how { margin-top: .5rem; }
.how.additional { padding-left: .75rem; }

.fine { color: var(--muted); font-size: .8125rem; line-height: 1.55; margin-bottom: .625rem; }

/* Every time on the record in one column, so they can be compared rather than hunted for. */
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: .3rem 1.5rem;
  margin: 1.25rem 0;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
  font-size: .8125rem;
}

dt { color: var(--muted); }

dd { margin: 0; font-variant-numeric: tabular-nums; }

/* Inside a card the rule above it is the card's own edge, so the list needs none. */
section dl { margin: .5rem 0 1rem; padding-top: 0; border-top: 0; }

section {
  margin: 0 0 1.25rem;
  padding: 1.25rem 1.375rem;
  border: 1px solid var(--line);
  border-radius: 10px;
}

section > :last-child { margin-bottom: 0; }

form { margin: 0 0 1.5rem; }

label { display: block; margin: 0 0 .75rem; color: var(--muted); font-size: .8125rem; }

input, textarea {
  display: block;
  width: 100%;
  margin-top: .375rem;
  padding: .5rem .625rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  font: .875rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Height comes from the rows attribute, which differs per box. */
textarea { resize: vertical; }

input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

button {
  padding: .5rem 1rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: var(--surface);
  font: 500 .9375rem/1.4 inherit;
  cursor: pointer;
}

button + button { margin-left: .5rem; border-color: var(--line); background: none; color: var(--ink); }

fieldset { margin: 0 0 1.25rem; padding: 1rem 1.125rem .25rem; border: 1px solid var(--line); border-radius: 8px; }

legend { padding: 0 .375rem; color: var(--muted); font-size: .8125rem; }

fieldset label { display: flex; align-items: baseline; gap: .5rem; color: var(--ink); font-size: .9375rem; }

fieldset input { width: auto; margin: 0; }

fieldset p { margin: .25rem 0 .875rem 1.5rem; color: var(--muted); font-size: .8125rem; }
`;

/**
 * A short digest of the sheet above, put in the link's query so a release that changes the
 * styling changes its address. Without that the only safe cache is no cache: a reader who
 * once loaded a page holds the sheet it came with, and the next release renders inside it.
 */
export const styleVersion = (() => {
  let hash = 0x811c9dc5;

  for (const char of stylesheet) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;

  return hash.toString(36);
})();
