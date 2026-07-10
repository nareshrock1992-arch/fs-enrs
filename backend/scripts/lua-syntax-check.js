#!/usr/bin/env node
/**
 * Lua syntax gate — Phase 2 item 1.
 *
 * Runs every string luaGenerator.js can produce through a real Lua 5.2
 * compiler in check-only mode (`luac5.2 -p`), matching FreeSWITCH's
 * embedded Lua version. This is what would have caught the bare `goto`
 * table key bug in seconds instead of five real phone calls — a syntax
 * error like that is invisible to grep/eslint (Lua isn't JS) and only
 * ever surfaces when FreeSWITCH itself tries to load the file, at which
 * point a real caller is already mid-call.
 *
 * The current architecture generates ONE fixed executor file at deploy
 * time (ivr_executor.lua) — the node graph is fetched over HTTP at call
 * time, not baked into the generated file — so "representative node-graph
 * inputs" here means representative *generator inputs* (apiBase/apiKey/
 * ttsEngine), including edge cases that stress the string-escaping paths
 * (quotes, empty strings, unicode). Once Phase 3's per-node-type Lua
 * templates exist, extend FIXTURES below to cover each template's output
 * too — this script's shape doesn't need to change, only the fixture list.
 *
 * Usage:  node backend/scripts/lua-syntax-check.js
 * Exit code 0 = every fixture is syntactically valid Lua 5.2.
 * Exit code 1 = at least one fixture failed, or no Lua 5.2 compiler was
 *               found on PATH (this is a hard failure, not a skip — a
 *               missing compiler means this gate silently isn't running).
 */

import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { generateIvrExecutorLua } from '../src/utils/luaGenerator.js';

const LUAC_CANDIDATES = ['luac5.2', 'luac5.1', 'luac'];

function findLuac() {
  for (const bin of LUAC_CANDIDATES) {
    try {
      execFileSync(bin, ['-v'], { stdio: 'pipe' });
      return bin;
    } catch { /* try next */ }
  }
  return null;
}

const FIXTURES = [
  {
    name: 'default config',
    input: { apiBase: 'http://127.0.0.1:4100', apiKey: 'a-normal-key-1234567890', ttsEngine: 'flite|kal' },
  },
  {
    name: 'empty apiKey',
    input: { apiBase: 'http://127.0.0.1:4100', apiKey: '', ttsEngine: 'flite|kal' },
  },
  {
    name: 'apiBase and apiKey containing double quotes (must be escaped, not break the generated string literal)',
    input: { apiBase: 'http://127.0.0.1:4100', apiKey: 'key"with"quotes', ttsEngine: 'flite|kal' },
  },
  {
    name: 'ttsEngine containing a pipe and quote',
    input: { apiBase: 'http://127.0.0.1:4100', apiKey: 'k', ttsEngine: 'piper|"voice"' },
  },
  {
    name: 'no config at all (all defaults)',
    input: {},
  },
  {
    name: 'apiBase with a trailing slash and unicode in apiKey',
    input: { apiBase: 'https://example.com:4100/', apiKey: 'ключ-üñïçødé', ttsEngine: 'flite|kal' },
  },
];

function main() {
  const luac = findLuac();
  if (!luac) {
    console.error(
      '[lua-syntax-check] FAIL: no Lua 5.2 compiler found on PATH (tried: ' +
      LUAC_CANDIDATES.join(', ') + '). This gate cannot run without one — install lua5.2 ' +
      '(apt-get install -y lua5.2) rather than skip this check.'
    );
    process.exit(1);
  }
  console.log(`[lua-syntax-check] Using ${luac}`);

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'lua-syntax-check-'));
  let failures = 0;

  try {
    for (const fixture of FIXTURES) {
      const lua = generateIvrExecutorLua(fixture.input);
      const filePath = path.join(tmpDir, 'test.lua');
      writeFileSync(filePath, lua, 'utf8');

      try {
        execFileSync(luac, ['-p', filePath], { stdio: 'pipe' });
        console.log(`  ✓ ${fixture.name}`);
      } catch (err) {
        failures++;
        console.error(`  ✗ ${fixture.name}`);
        console.error('    ' + (err.stderr?.toString() || err.message).trim().split('\n').join('\n    '));
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n[lua-syntax-check] FAIL: ${failures}/${FIXTURES.length} fixture(s) failed to parse.`);
    process.exit(1);
  }
  console.log(`\n[lua-syntax-check] PASS: all ${FIXTURES.length} fixtures are syntactically valid Lua 5.2.`);
}

main();
