const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// The repository has no build step: Vercel serves every uploaded file that is
// not a function. .vercelignore keeps the repository's own material (audit
// and handoff notes, migrations, tests, CI) off the public site while the
// storefront pages, assets and the api/ functions deploy as before.

function ignorePatterns() {
  return fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// The subset of .gitignore syntax this file uses: "dir/", "*.ext" (any
// depth), and exact root-relative paths ("/file" or "file/path"). The first
// test pins the file to that subset, so this matcher cannot silently disagree
// with Vercel's.
function ignored(file, patterns) {
  return patterns.some((p) => {
    if (p.endsWith('/')) return file.startsWith(p.replace(/^\//, ''));
    if (p.startsWith('*.')) return file.endsWith(p.slice(1));
    return file === p.replace(/^\//, '');
  });
}

test('.vercelignore uses only plain directory, extension and path patterns', () => {
  for (const p of ignorePatterns()) {
    assert.ok(!p.startsWith('!'), `no negation: ${p}`);
    assert.match(p, /^(\/?[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/?|\*\.[a-z]+)$/, p);
  }
});

test('the deployment keeps the storefront and the functions, and drops repository material', () => {
  const patterns = ignorePatterns();
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const kept = files.filter((f) => !ignored(f, patterns));
  const dropped = files.filter((f) => ignored(f, patterns));

  for (const f of files) {
    if (f.startsWith('api/') || f.endsWith('.html')) assert.ok(kept.includes(f), `${f} must deploy`);
  }
  for (const f of ['package.json', 'package-lock.json', 'vercel.json', 'assets/css/style.css', 'assets/js/payments.js', 'assets/js/main.js', 'assets/img/favicon.svg']) {
    assert.ok(kept.includes(f), `${f} must deploy`);
  }
  for (const f of files) {
    if (f.startsWith('supabase/') || f.startsWith('test/') || f.startsWith('.github/') || f.endsWith('.md')) {
      assert.ok(dropped.includes(f), `${f} must not deploy`);
    }
  }
  // A reference for the Labs side, loaded by no Skin page.
  assert.ok(dropped.includes('assets/js/payment-embed-parent.js'));
  for (const html of files.filter((f) => f.endsWith('.html'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, html), 'utf8'), /payment-embed-parent/, html);
  }
});
