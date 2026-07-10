#!/usr/bin/env node
/**
 * XML structural gate — Phase 2 item 2.
 *
 * Runs every xmlGenerator.js output (both nested and flat dialplan
 * layouts, with and without Test Mode) through `xmllint --noout` for
 * well-formedness, AND asserts the project-specific structural rule from
 * Phase 1 item 5: nested layout must be a bare <include><extension> with
 * NO <context> tag (a second nested <context> at that splice point is
 * invalid and FreeSWITCH silently drops the whole fragment with zero
 * error — this was the single most expensive bug of the whole debugging
 * session, discovered only after 6+ real test calls). xmllint alone can't
 * catch that: both layouts are well-formed XML, only one is *correct* for
 * a given target directory.
 *
 * Usage:  node backend/scripts/xml-structural-check.js
 */

import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { generateDialplanXml, generateDiagnosticsXml } from '../src/utils/xmlGenerator.js';

function findXmllint() {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const SAMPLE_BINDINGS = [
  { number: '1222', flow_uuid: 'aaaa-1111', flow_name: 'ERS 1222', version_number: 3 },
  { number: '1888', flow_uuid: 'bbbb-2222', flow_name: 'ENS Blast', version_number: 1 },
];

const FIXTURES = [
  {
    name: 'generateDialplanXml — nested, no test mode, with bindings',
    xml: () => generateDialplanXml(SAMPLE_BINDINGS, { nested: true }),
    mustNotContain: ['<context'],
    mustContain: ['<include>', '<extension name="enrs_ivr_1222"', '<extension name="enrs_ivr_1888"'],
  },
  {
    name: 'generateDialplanXml — flat, no test mode, with bindings',
    xml: () => generateDialplanXml(SAMPLE_BINDINGS, { nested: false }),
    mustContain: ['<context name="default">', '</context>', '<extension name="enrs_ivr_1222"'],
  },
  {
    name: 'generateDialplanXml — nested, empty bindings (no numbers bound yet)',
    xml: () => generateDialplanXml([], { nested: true }),
    mustNotContain: ['<context'],
    mustContain: ['<include>', 'No IVR numbers bound yet'],
  },
  {
    name: 'generateDialplanXml — nested, Test Mode enabled for one flow',
    xml: () => generateDialplanXml(SAMPLE_BINDINGS, {
      nested: true,
      testMode: { enabled: true, callerId: '5551234567', testFlowUuids: new Set(['aaaa-1111']) },
    }),
    mustNotContain: ['<context'],
    mustContain: ['caller_id_number=5551234567'],
  },
  {
    name: 'generateDiagnosticsXml — nested',
    xml: () => generateDiagnosticsXml({ nested: true }),
    mustNotContain: ['<context'],
    mustContain: ['enrs_diagnostics_probe'],
  },
  {
    name: 'generateDiagnosticsXml — flat',
    xml: () => generateDiagnosticsXml({ nested: false }),
    mustContain: ['<context name="default">', 'enrs_diagnostics_probe'],
  },
];

function main() {
  const hasXmllint = findXmllint();
  if (!hasXmllint) {
    console.error(
      '[xml-structural-check] FAIL: xmllint not found on PATH. Install libxml2-utils ' +
      '(apt-get install -y libxml2-utils) rather than skip this check.'
    );
    process.exit(1);
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'xml-structural-check-'));
  let failures = 0;

  try {
    for (const fixture of FIXTURES) {
      const xml = fixture.xml();
      const filePath = path.join(tmpDir, 'test.xml');
      writeFileSync(filePath, xml, 'utf8');

      const problems = [];

      try {
        execFileSync('xmllint', ['--noout', filePath], { stdio: 'pipe' });
      } catch (err) {
        problems.push('not well-formed XML: ' + (err.stderr?.toString() || err.message).trim());
      }

      for (const must of fixture.mustContain || []) {
        if (!xml.includes(must)) problems.push(`missing required content: "${must}"`);
      }
      for (const mustNot of fixture.mustNotContain || []) {
        if (xml.includes(mustNot)) problems.push(`contains forbidden content: "${mustNot}"`);
      }

      if (problems.length === 0) {
        console.log(`  ✓ ${fixture.name}`);
      } else {
        failures++;
        console.error(`  ✗ ${fixture.name}`);
        for (const p of problems) console.error(`    - ${p}`);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n[xml-structural-check] FAIL: ${failures}/${FIXTURES.length} fixture(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[xml-structural-check] PASS: all ${FIXTURES.length} fixtures are well-formed and structurally correct.`);
}

main();
