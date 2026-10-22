import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI command registration', () => {
  it('registers the TOML configuration commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toMatch(/\.command\(['"]migrate['"]\)/);
    expect(source).toContain('migrateToToml');
  });

  it('registers app-secret options for non-interactive app bootstrap commands', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    const appSecretOptions = source.match(/--app-secret <secret>/g) ?? [];
    expect(appSecretOptions.length).toBeGreaterThanOrEqual(3);
  });

  it('exposes machine-readable build and deployment status', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toContain("formatBuildVersion()");
    expect(source).toContain("'print build, service, runtime and config-revision state as JSON'");
    expect(source).toContain('json: opts.json');
  });

  it('registers the standalone Slack channel and named secret storage', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'cli', 'index.ts'), 'utf8');

    expect(source).toMatch(/\.command\(['"]slack['"]\)/);
    expect(source).toContain("runSlack");
    expect(source).toMatch(/\.command\(['"]put <id>['"]\)/);
    expect(source).toContain('runSecretPut');
  });
});
