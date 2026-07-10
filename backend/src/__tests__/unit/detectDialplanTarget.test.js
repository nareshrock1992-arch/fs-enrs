import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import FreeSwitchPathService from '../../services/freeSwitchPathService.js';

// Regression guards for the double-wrap field failure: a deployed box had
// FS_DIALPLAN_DIR pointed at the nested include directory ITSELF
// (.../dialplan/default) rather than the documented search root
// (.../dialplan). The old detector found no default.xml in that dir,
// fell back to "flat → wrap in <context>", and wrote a wrapped file into
// a directory whose contents are spliced inside an already-open
// <context name="default"> — a doubled context tag FreeSWITCH silently
// drops with zero error. Fixed by also checking the PARENT directory's
// default.xml.

const DEFAULT_XML_NESTED = `<?xml version="1.0"?>
<include>
  <context name="default">
    <extension name="something"><condition/></extension>
    <X-PRE-PROCESS cmd="include" data="default/*.xml"/>
  </context>
</include>`;

let scratch;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); scratch = null; });

function svc(dialplanDir) {
  return new FreeSwitchPathService({ dialplanDir: dialplanDir.replace(/\\/g, '/') });
}

describe('detectDialplanTargetDir — layout detection', () => {
  it('search root with a nested include in its own default.xml → nested target dir, bare', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'dp-'));
    const dialplan = path.join(scratch, 'dialplan');
    mkdirSync(path.join(dialplan, 'default'), { recursive: true });
    writeFileSync(path.join(dialplan, 'default.xml'), DEFAULT_XML_NESTED);

    const result = await svc(dialplan).detectDialplanTargetDir();
    expect(result.nested).toBe(true);
    expect(result.dir.replace(/\\/g, '/')).toBe(path.join(dialplan, 'default').replace(/\\/g, '/'));
  });

  it('FS_DIALPLAN_DIR pointing at the nested dir ITSELF → still detected as nested via the parent default.xml (the field failure)', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'dp-'));
    const dialplan = path.join(scratch, 'dialplan');
    const nestedDir = path.join(dialplan, 'default');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(path.join(dialplan, 'default.xml'), DEFAULT_XML_NESTED);

    // Misconfigured-but-reasonable: env var points at dialplan/default
    const result = await svc(nestedDir).detectDialplanTargetDir();
    expect(result.nested).toBe(true);
    expect(result.dir.replace(/\\/g, '/')).toBe(nestedDir.replace(/\\/g, '/'));
  });

  it('genuinely flat layout (no default.xml anywhere relevant) → flat, wrapped', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'dp-'));
    const dialplan = path.join(scratch, 'dialplan');
    mkdirSync(dialplan, { recursive: true });

    const result = await svc(dialplan).detectDialplanTargetDir();
    expect(result.nested).toBe(false);
    expect(result.dir.replace(/\\/g, '/')).toBe(dialplan.replace(/\\/g, '/'));
  });

  it('default.xml present but with NO nested include → flat, wrapped', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'dp-'));
    const dialplan = path.join(scratch, 'dialplan');
    mkdirSync(dialplan, { recursive: true });
    writeFileSync(path.join(dialplan, 'default.xml'),
      '<include><context name="default"><extension name="x"><condition/></extension></context></include>');

    const result = await svc(dialplan).detectDialplanTargetDir();
    expect(result.nested).toBe(false);
  });

  it('tolerates attribute spacing and " />" self-close variants in the include line', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'dp-'));
    const dialplan = path.join(scratch, 'dialplan');
    mkdirSync(path.join(dialplan, 'default'), { recursive: true });
    writeFileSync(path.join(dialplan, 'default.xml'), `
<include>
  <context name = "default" >
    <X-PRE-PROCESS cmd = "include"  data = "default/*.xml" />
  </context>
</include>`);

    const result = await svc(dialplan).detectDialplanTargetDir();
    expect(result.nested).toBe(true);
  });
});
