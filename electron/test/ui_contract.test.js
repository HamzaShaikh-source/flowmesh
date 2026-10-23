'use strict';
/**
 * The front end is plain static HTML + scripts with no build step, so nothing would catch a
 * renamed id or a blocked inline style until someone clicked the page. These checks make the
 * contract between index.html and its scripts explicit.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const WEB = path.join(__dirname, '..', '..', 'web');
const read = (name) => fs.readFileSync(path.join(WEB, name), 'utf8');
const html = read('index.html');
const SCRIPTS = ['core.js', 'ui.js', 'tools.js', 'pages.js', 'voice-grammar.js', 'voice.js', 'motion.js'];

const idsInHtml = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

test('ids in index.html are unique', () => {
  const seen = new Set();
  const dupes = idsInHtml.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(dupes, []);
});

test('every id the scripts look up exists in the page', () => {
  const known = new Set(idsInHtml);
  const missing = [];
  for (const file of SCRIPTS) {
    const source = read(file);
    const found = [...source.matchAll(/\$\('([A-Za-z][A-Za-z0-9_-]*)'\)/g)].map((m) => m[1])
      .concat([...source.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
    for (const id of found) {
      // 'stat' + id + 'V' style lookups are built at runtime; those ids are checked below.
      if (!known.has(id)) missing.push(`${file}: #${id}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('the stat cards the Home page fills in all exist', () => {
  for (const name of ['Wispr', 'Tools', 'Runs', 'Model']) {
    for (const suffix of ['', 'V', 'S']) assert.ok(idsInHtml.includes(`stat${name}${suffix}`), `stat${name}${suffix}`);
  }
});

test('no inline style attributes: the page CSP (style-src self) would silently block them', () => {
  assert.ok(!/\sstyle\s*=/.test(html), 'index.html has an inline style attribute');
  const headers = read('_headers');
  assert.match(headers, /style-src 'self'(?!\s*'unsafe-inline')/);
  assert.match(headers, /microphone=\(self\)/, 'the hosted page must allow the mic for itself only');
});

test('there is no inline <script> and every referenced script and stylesheet exists', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'inline script found');
  for (const [, file] of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(WEB, file)), file);
  for (const [, file] of html.matchAll(/<link[^>]*\bhref="([^"#]+\.(?:css|svg|woff2))"/g)) assert.ok(fs.existsSync(path.join(WEB, file)), file);
  for (const file of SCRIPTS) assert.ok(html.includes(`src="${file}"`), `${file} is not loaded`);
});

test('every nav link has a page and every page has a nav link', () => {
  const routes = [...html.matchAll(/data-route="([a-z]+)"/g)].map((m) => m[1]);
  const pages = [...html.matchAll(/data-page="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...routes].sort(), [...pages].sort());
  assert.equal(new Set(routes).size, routes.length);
  const router = read('pages.js');
  for (const route of routes) assert.match(router, new RegExp(`\\b${route}:`), `${route} missing from the router table`);
});

test('icons used in markup exist in the sprite, and the fonts have no glyph we rely on that they lack', () => {
  const sprite = new Set([...html.matchAll(/<symbol id="(i-[a-z]+)"/g)].map((m) => m[1]));
  for (const [, id] of html.matchAll(/<use href="#(i-[a-z]+)"/g)) assert.ok(sprite.has(id), id);
  // The self-hosted fonts have no arrow, check or diagonal-arrow glyph; text arrows fall back to
  // another font and look wrong, so markup and UI strings must use the SVG icons instead.
  const text = html.replace(/<symbol[\s\S]*?<\/symbol>/g, '') + SCRIPTS.map(read).join('\n');
  assert.ok(!/[←→↗✓]/.test(text), 'a text arrow or check glyph is used');
});

test('mode-specific blocks are hidden until the runtime is known', () => {
  const css = read('app.css');
  assert.match(css, /body\[data-mode="detecting"\] \[data-only\]/);
  assert.match(html, /<body data-mode="detecting">/);
});

test('reduced motion switches off every infinite animation', () => {
  const css = read('app.css');
  const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  for (const selector of ['.caret', '.marquee-track', '.pulse', '.wave i']) assert.ok(block.includes(selector), selector);
  assert.match(block, /animation: none !important/);
});
