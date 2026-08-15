import { describe, expect, it } from 'vitest';
import {
  compareReleaseVersions,
  insertChangelogEntry,
  parsePrepareReleaseArgs,
  updatePackageVersion,
} from './prepare-release.js';

const COMPLETE_ARGS = [
  '--version', '0.2.0',
  '--reviewer', 'release-reviewer',
  '--reviewer-time-zone', 'Asia/Riyadh',
  '--checked-at', '2026-07-25',
  '--network-checked-at', '2026-07-25',
  '--summary', 'Added one established calculator and its generated documentation.',
  '--confirm-currentness',
];

describe('release preparation', () => {
  it('requires an explicit currentness confirmation and complete review metadata', () => {
    expect(parsePrepareReleaseArgs(COMPLETE_ARGS)).toMatchObject({
      version: '0.2.0',
      reviewer: 'release-reviewer',
      reviewerTimeZone: 'Asia/Riyadh',
      checkedAt: '2026-07-25',
      networkCheckedAt: '2026-07-25',
      confirmCurrentness: true,
    });
    expect(() => parsePrepareReleaseArgs(COMPLETE_ARGS.filter((entry) =>
      entry !== '--confirm-currentness'))).toThrow(/confirm-currentness/u);
  });

  it('orders exact release versions without accepting ambiguous forms', () => {
    expect(compareReleaseVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareReleaseVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareReleaseVersions('1.2.3', '2.0.0')).toBe(-1);
    expect(() => compareReleaseVersions('v1.2.3', '1.2.2')).toThrow(/exact X\.Y\.Z/u);
  });

  it('keeps package and lockfile versions aligned', () => {
    expect(JSON.parse(updatePackageVersion('{"name":"@oath-md/oath-mcp","version":"0.1.0"}', '0.2.0')))
      .toMatchObject({ name: '@oath-md/oath-mcp', version: '0.2.0' });
    expect(JSON.parse(updatePackageVersion(
      '{"name":"@oath-md/oath-mcp","version":"0.1.0","packages":{"":{"version":"0.1.0"}}}',
      '0.2.0',
      true,
    ))).toMatchObject({
      version: '0.2.0',
      packages: { '': { version: '0.2.0' } },
    });
  });

  it('adds one dated changelog entry ahead of historical releases', () => {
    const result = insertChangelogEntry(
      '# Changelog\n\nAll notable changes.\n\n## Unreleased\n\n- Existing release work.\n\n' +
      '## 0.1.0 — 2026-07-21\n\n- Initial release.\n',
      '0.2.0',
      '2026-07-25',
      'Added FIB-4.',
    );
    expect(result).toContain('## 0.2.0 — 2026-07-25\n\n- Added FIB-4.');
    expect(result).toContain('- Existing release work.');
    expect(result.indexOf('## Unreleased')).toBeLessThan(result.indexOf('## 0.2.0'));
    expect(result.indexOf('## 0.2.0')).toBeLessThan(result.indexOf('## 0.1.0'));
    expect(() => insertChangelogEntry(result, '0.2.0', '2026-07-25', 'Duplicate.'))
      .toThrow(/already contains/u);
  });
});
