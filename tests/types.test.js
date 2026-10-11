'use strict';

// src/*.d.ts are written by hand on top of @surea11y/core's own types.
// Compile a typical use of them with tsc --strict, so a declaration that
// doesn't fit the engine's types, or a name that stops resolving, fails
// here rather than in a user's project.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('the type declarations compile against @surea11y/core\'s and selenium-webdriver\'s types', () => {
  // TypeScript 7 exports no bin/tsc subpath, so find it beside its package.json.
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const file = path.join(__dirname, 'types', 'usage.ts');
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--lib', 'es2022,dom', '--types', 'selenium-webdriver', file], { stdio: 'pipe' });
  } catch (e) {
    assert.fail(String(e.stdout) + String(e.stderr));
  }
});
