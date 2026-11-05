import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  clearKeystoreDerivedKeyCache,
  getSecret,
  setSecret,
  type KeystoreRuntimeOptions,
} from '../../../src/config/keystore';
import { KEYSTORE_MASTER_KEY_ENV } from '../../../src/config/keystore/key-provider';
import { KeystoreError } from '../../../src/config/keystore/types';

const roots: string[] = [];

afterEach(async () => {
  clearKeystoreDerivedKeyCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('keystore', () => {
  it('stores new secrets under the local key by default', async () => {
    const paths = await tempPaths();
    const runtime: KeystoreRuntimeOptions = { env: {}, username: 'operator' };

    await setSecret('app-secret', 'value', paths, runtime);

    await expect(getSecret('app-secret', paths, runtime)).resolves.toBe('value');
    const stored = JSON.parse(await readFile(paths.secretsFile, 'utf8')) as {
      version: number;
      entries: Record<string, { keyId: string }>;
    };
    expect(stored.version).toBe(2);
    expect(stored.entries['app-secret']?.keyId).toBe('local-v2');
  });

  it('uses an externally supplied master key for new secrets', async () => {
    const paths = await tempPaths();
    const masterKey = 'container-master-key-with-sufficient-input';
    const runtime: KeystoreRuntimeOptions = {
      env: { [KEYSTORE_MASTER_KEY_ENV]: masterKey },
      username: 'operator',
    };

    await setSecret('app-secret', 'value', paths, runtime);

    await expect(getSecret('app-secret', paths, runtime)).resolves.toBe('value');
    const stored = JSON.parse(await readFile(paths.secretsFile, 'utf8')) as {
      entries: Record<string, { keyId: string }>;
    };
    expect(stored.entries['app-secret']?.keyId).toBe('env-v2');

    await expect(getSecret('app-secret', paths, {
      ...runtime,
      env: { [KEYSTORE_MASTER_KEY_ENV]: 'different-master-key' },
    })).rejects.toMatchObject({ code: 'decrypt-failed' });
  });

  it('re-encrypts local entries under a newly configured master key on read', async () => {
    const paths = await tempPaths();
    await setSecret('old', 'old-value', paths, { env: {}, username: 'operator' });

    await expect(getSecret('old', paths, {
      env: { [KEYSTORE_MASTER_KEY_ENV]: 'container-master-key' },
      username: 'operator',
    })).resolves.toBe('old-value');

    const stored = JSON.parse(await readFile(paths.secretsFile, 'utf8')) as {
      entries: Record<string, { keyId: string }>;
    };
    expect(stored.entries.old?.keyId).toBe('env-v2');
  });

  it('refuses an unknown store format', async () => {
    const paths = await tempPaths();
    await mkdir(paths.profileDir, { recursive: true });
    await writeFile(paths.secretsFile, '{"version":3,"entries":{}}\n', { mode: 0o600 });

    await expect(getSecret('existing', paths, {
      env: {},
      username: 'operator',
    })).rejects.toBeInstanceOf(KeystoreError);
  });

  it('refuses to mint a new salt beside existing encrypted entries', async () => {
    const paths = await tempPaths();
    await mkdir(paths.profileDir, { recursive: true });
    await writeFile(paths.secretsFile, `${JSON.stringify({
      version: 2,
      entries: {
        existing: {
          keyId: 'local-v2',
          iv: Buffer.alloc(12).toString('base64'),
          data: '',
          tag: Buffer.alloc(16).toString('base64'),
        },
      },
    })}\n`, { mode: 0o600 });

    await expect(getSecret('existing', paths, {
      env: {},
      username: 'operator',
    })).rejects.toMatchObject({ code: 'invalid-salt' });
  });
});

async function tempPaths() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-keystore-'));
  roots.push(root);
  return resolveAppPaths({ rootDir: root, profile: 'claude' });
}
