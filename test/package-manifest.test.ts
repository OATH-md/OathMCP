import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackManifest {
  files: Array<{ path: string }>;
}

interface PackageJson {
  bundledDependencies?: string[];
  bundleDependencies?: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  exports: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, unknown>;
}

describe('published package manifest', () => {
  it('ships the licensed runtime and the complete public documentation contract', () => {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      encoding: 'utf8',
      env: { ...process.env, npm_config_loglevel: 'silent' },
    });
    const manifests = JSON.parse(output) as PackManifest[];
    expect(manifests).toHaveLength(1);
    const files = manifests[0]?.files.map((entry) => entry.path).sort() ?? [];

    for (const required of ['dist/', 'specs/', 'validation/', 'templates/']) {
      expect(files.some((path) => path.startsWith(required)), `missing ${required}`).toBe(true);
    }
    const calculatorIds = readdirSync('specs')
      .filter((path) => path.endsWith('.yaml'))
      .map((path) => path.replace(/\.yaml$/, ''))
      .sort();
    expect(calculatorIds).toHaveLength(40);
    for (const calculatorId of calculatorIds) {
      expect(files).toContain(`specs/${calculatorId}.yaml`);
      expect(files).toContain(`validation/calculators/${calculatorId}.yaml`);
    }
    for (const entrypoint of ['dist/server/stdio.js', 'dist/engine/index.js', 'dist/server/mcp.js']) {
      expect(files).toContain(entrypoint);
    }
    expect(files.some((path) => path.startsWith('dist/cli/'))).toBe(false);
    for (const publicDocument of [
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'CHANGELOG.md',
      'LICENSE',
      'NOTICE',
      'docs/AUTHORING.md',
      'docs/HOSTING.md',
      'docs/HOUSE_STYLE.md',
      'docs/RELEASE.md',
      'docs/RESPONSIBLE_USE.md',
    ]) expect(files).toContain(publicDocument);

    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;
    expect(packageJson.dependencies).toMatchObject({
      '@modelcontextprotocol/express': '^2.0.0',
      '@modelcontextprotocol/node': '^2.0.0',
      '@modelcontextprotocol/server': '^2.0.0',
    });
    expect(packageJson.devDependencies['@modelcontextprotocol/client']).toBe('^2.0.0');
    for (const runtimeDependencies of [
      packageJson.dependencies,
      packageJson.optionalDependencies ?? {},
      packageJson.peerDependencies ?? {},
    ]) {
      expect(runtimeDependencies).not.toHaveProperty('@modelcontextprotocol/client');
      expect(runtimeDependencies).not.toHaveProperty('@modelcontextprotocol/sdk');
    }
    for (const dependencySurface of [packageJson.dependencies, packageJson.devDependencies]) {
      expect(dependencySurface).not.toHaveProperty('@modelcontextprotocol/sdk');
    }
    for (const bundled of [
      packageJson.bundledDependencies ?? [],
      packageJson.bundleDependencies ?? [],
    ]) {
      expect(bundled).not.toContain('@modelcontextprotocol/client');
      expect(bundled).not.toContain('@modelcontextprotocol/sdk');
    }
    expect(packageJson.overrides ?? {}).not.toHaveProperty('@hono/node-server');
    const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as PackageLock;
    expect(Object.keys(packageLock.packages).some((path) =>
      path === 'node_modules/@modelcontextprotocol/sdk'
      || path.endsWith('/node_modules/@modelcontextprotocol/sdk'))).toBe(false);
    expect(packageJson.exports).toEqual({
      '.': './dist/engine/index.js',
      './server': './dist/server/mcp.js',
    });

    for (const internalHelper of [
      'in-memory-client', 'compatibility', 'validation-case-runner',
    ]) {
      expect(files.some((path) => path.startsWith(`dist/server/${internalHelper}.`))).toBe(false);
    }

    const packedFiles = new Set(files);
    const markdownLink = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const source of files.filter((path) => path.endsWith('.md'))) {
      const markdown = readFileSync(source, 'utf8');
      for (const match of markdown.matchAll(markdownLink)) {
        const rawTarget = match[1];
        if (rawTarget === undefined) continue;
        const target = rawTarget.startsWith('<') && rawTarget.endsWith('>')
          ? rawTarget.slice(1, -1)
          : rawTarget;
        if (/^(?:[a-z]+:|#)/i.test(target)) continue;
        const pathOnly = target.split('#', 1)[0];
        if (!pathOnly) continue;
        const directoryTarget = pathOnly.endsWith('/');
        const linkPath = directoryTarget ? pathOnly.slice(0, -1) : pathOnly;
        const resolved = posix.normalize(posix.join(posix.dirname(source), decodeURIComponent(linkPath)));
        const present = directoryTarget
          ? files.some((path) => path.startsWith(`${resolved}/`))
          : packedFiles.has(resolved);
        expect(present, `${source} links to unpacked path ${target}`).toBe(true);
      }
    }
    expect(files.filter((path) => path.startsWith('templates/'))).toHaveLength(12);
    expect(files.some((path) => path.startsWith('drafts/'))).toBe(false);
    for (const localToolingDirectory of [
      '.agents/', '.claude/', '.codex/', '.cursor/', '.orchestra/',
    ]) {
      expect(files.some((path) => path.startsWith(localToolingDirectory))).toBe(false);
    }
    expect(files.some((path) => /(^|\/)(private|fixtures)(\/|$)/i.test(path))).toBe(false);
  });
});
