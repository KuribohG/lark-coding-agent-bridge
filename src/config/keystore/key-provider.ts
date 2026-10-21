import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname as osHostname, userInfo } from 'node:os';
import { writeFileAtomic } from '../../platform/atomic-write';
import {
  KeystoreError,
  type KeystoreKeyId,
  type KeystorePaths,
  type KeystoreRuntimeOptions,
  type SecretKeyMaterial,
  type SecretKeyProvider,
} from './types';

export const KEYSTORE_MASTER_KEY_ENV = 'LARK_CHANNEL_KEYSTORE_MASTER_KEY';

const KEY_LEN = 32;
const PBKDF2_ITER = 100_000;
const derivedKeyCache = new Map<string, Buffer>();

/**
 * Resolve stable encryption keys outside the serialized secret store.
 *
 * Active writes use an externally supplied production key when configured,
 * otherwise a local key derived from the stable username and persisted salt.
 * Hostname is retained only to read legacy v1 envelopes; it is deliberately
 * not part of new keys because container hostnames are ephemeral.
 */
export class KeystoreKeyProvider implements SecretKeyProvider {
  private readonly env: NodeJS.ProcessEnv;
  private readonly hostname: string;
  private readonly username: string;
  private salt?: Promise<Buffer>;

  constructor(
    private readonly paths: KeystorePaths,
    options: KeystoreRuntimeOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.hostname = options.hostname ?? osHostname();
    this.username = options.username ?? userInfo().username;
  }

  async activeKey(): Promise<SecretKeyMaterial> {
    return this.keyFor(this.masterKey() ? 'env-v2' : 'local-v2');
  }

  async keyFor(id: KeystoreKeyId): Promise<SecretKeyMaterial> {
    const seed = this.seedFor(id);
    if (seed === undefined) {
      throw new KeystoreError(
        'missing-key',
        `keystore key ${id} is not configured; set ${KEYSTORE_MASTER_KEY_ENV}`,
      );
    }

    const salt = await this.loadOrCreateSalt();
    const cacheKey = [
      this.paths.keystoreSaltFile,
      id,
      createHash('sha256').update(seed).digest('hex'),
    ].join('|');
    let key = derivedKeyCache.get(cacheKey);
    if (!key) {
      key = pbkdf2Sync(seed, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
      derivedKeyCache.set(cacheKey, key);
    }
    return { id, key };
  }

  private seedFor(id: KeystoreKeyId): string | undefined {
    switch (id) {
      case 'env-v2': {
        const masterKey = this.masterKey();
        return masterKey ? `env-v2\0${masterKey}` : undefined;
      }
      case 'local-v2':
        return `local-v2\0${this.username}`;
      case 'legacy-v1':
        return `${this.hostname}|${this.username}`;
    }
  }

  private masterKey(): string | undefined {
    const value = this.env[KEYSTORE_MASTER_KEY_ENV];
    return value && value.trim() ? value : undefined;
  }

  private loadOrCreateSalt(): Promise<Buffer> {
    this.salt ??= this.readOrCreateSalt();
    return this.salt;
  }

  private async readOrCreateSalt(): Promise<Buffer> {
    try {
      const salt = await readFile(this.paths.keystoreSaltFile);
      if (salt.length !== KEY_LEN) {
        throw new KeystoreError(
          'invalid-salt',
          `keystore salt must be ${KEY_LEN} bytes: ${this.paths.keystoreSaltFile}`,
        );
      }
      return salt;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // Never mint a fresh salt next to an existing encrypted store: every
    // existing entry would become undecryptable. Missing state should be
    // recovered explicitly instead of being silently reset.
    try {
      await readFile(this.paths.secretsFile);
      throw new KeystoreError(
        'invalid-salt',
        `keystore salt is missing while ${this.paths.secretsFile} exists`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const salt = randomBytes(KEY_LEN);
    await writeFileAtomic(this.paths.keystoreSaltFile, salt, { mode: 0o600 });
    return salt;
  }
}

export function clearDerivedKeyCache(): void {
  derivedKeyCache.clear();
}

export function derivedKeyCacheSize(): number {
  return derivedKeyCache.size;
}
