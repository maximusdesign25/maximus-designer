// ═══════════════════════════════════════════════════════════
//  MAXIMUS PRO · production build
//  Minifies the HTML documents (inline CSS + JS) and copies the
//  static assets into dist/. Netlify publishes dist/.
//
//  The SOURCE files remain a fully-working app — `netlify dev`
//  (see [dev] in netlify.toml) serves the raw source un-minified,
//  so local development never depends on this build step.
//
//  Note on minifyJS: html-minifier-terser runs Terser with its
//  defaults, which mangle ONLY function-local variables. Top-level
//  names (render, calcPrice, …) and external globals (morphdom,
//  PDFLib, jspdf) are left intact, so cross-script references and
//  the single-file architecture keep working.
// ═══════════════════════════════════════════════════════════
import { minify } from 'html-minifier-terser';
import { readFile, writeFile, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const HTML_OPTS = {
  collapseWhitespace: true,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true,
  keepClosingSlash: true,
  caseSensitive: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
};

const HTML_FILES  = ['index.html', 'admin.html'];
const STATIC_FILES = ['sw.js', 'manifest.webmanifest', 'cover.pdf', '_headers', '_redirects'];
const STATIC_DIRS  = ['icons'];

async function run() {
  await rm('dist', { recursive: true, force: true });
  await mkdir('dist', { recursive: true });

  for (const f of HTML_FILES) {
    if (!existsSync(f)) continue;
    const src = await readFile(f, 'utf8');
    const out = await minify(src, HTML_OPTS);
    await writeFile(`dist/${f}`, out);
    const before = Buffer.byteLength(src), after = Buffer.byteLength(out);
    console.log(`minify ${f}: ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB  (${(100 - (after / before) * 100).toFixed(0)}% smaller)`);
  }

  for (const f of STATIC_FILES) {
    if (existsSync(f)) { await copyFile(f, `dist/${f}`); console.log(`copy   ${f}`); }
  }
  for (const d of STATIC_DIRS) {
    if (existsSync(d)) { await cp(d, `dist/${d}`, { recursive: true }); console.log(`copy   ${d}/`); }
  }
  console.log('✓ build → dist/ complete');
}

run().catch((e) => { console.error(e); process.exit(1); });
