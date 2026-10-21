import {
  createCipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
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
  it('keeps v2 secrets readable when the container hostname changes', async () => {
    const paths = await tempPaths();
    const first: KeystoreRuntimeOptions = { env: {}, hostname: 'pod-a', username: 'operator' };
    const second: KeystoreRuntimeOptions = { env: {}, hostname: 'pod-b', username: 'operator' };

    await setSecret('app-secret', 'value', paths, first);

    await expect(getSecret('app-secret', paths, second)).resolves.toBe('value');
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
      hostname: 'pod-a',
      username: 'operator',
    };

    await setSecret('app-secret', 'value', paths, runtime);

    await expect(getSecret('app-secret', paths, {
      ...runtime,
      hostname: 'pod-b',
    })).resolves.toBe('value');
    const stored = JSON.parse(await readFile(paths.secretsFile, 'utf8')) as {
      entries: Record<string, { keyId: string }>;
    };
    expect(stored.entries['app-secret']?.keyId).toBe('env-v2');

    await expect(getSecret('app-secret', paths, {
      ...runtime,
      env: { [KEYSTORE_MASTER_KEY_ENV]: 'different-master-key' },
    })).rejects.toMatchObject({ code: 'decrypt-failed' });
  });

  it('migrates decryptable v1 entries on the next read', async () => {
    const paths = await tempPaths();
    const runtime: KeystoreRuntimeOptions = {
      env: {},
      hostname: 'old-host',
      username: 'operator',
    };
    const salt = randomBytes(32);
    await mkdir(paths.profileDir, { recursive: true });
    await writeFile(paths.keystoreSaltFile, salt, { mode: 0o600 });
    await writeFile(paths.secretsFile, `${JSON.stringify({
      version: 1,
      entries: { old: legacyEnvelope('old-value', salt, 'old-host', 'operator') },
    })}\n`, { mode: 0o600 });

    await expect(getSecret('old', paths, runtime)).resolves.toBe('old-value');

    const stored = JSON.parse(await readFile(paths.secretsFile, 'utf8')) as {
      version: number;
      entries: Record<string, { keyId: string }>;
    };
    expect(stored.version).toBe(2);
    expect(stored.entries.old?.keyId).toBe('local-v2');
    await expect(getSecret('old', paths, {
      ...runtime,
      hostname: 'new-host',
    })).resolves.toBe('old-value');
  });

  it('refuses an unknown store format', async () => {
    const paths = await tempPaths();
    await mkdir(paths.profileDir, { recursive: true });
    await writeFile(paths.secretsFile, '{"version":3,"entries":{}}\n', { mode: 0o600 });

    await expect(getSecret('existing', paths, {
      env: {},
      hostname: 'pod',
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
      hostname: 'pod',
      username: 'operator',
    })).rejects.toMatchObject({ code: 'invalid-salt' });
  });
});

async function tempPaths() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-keystore-'));
  roots.push(root);
  return resolveAppPaths({ rootDir: root, profile: 'claude' });
}

function legacyEnvelope(
  plaintext: string,
  salt: Buffer,
  hostname: string,
  username: string,
) {
  const key = pbkdf2Sync(`${hostname}|${username}`, salt, 100_000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}
