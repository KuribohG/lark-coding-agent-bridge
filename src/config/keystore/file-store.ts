import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../../platform/atomic-write';
import {
  KeystoreError,
  type KeystoreKeyId,
  type KeystorePaths,
  type SecretEnvelope,
  type SecretStore,
  type SecretStoreFile,
} from './types';

interface RawEnvelope {
  keyId?: unknown;
  iv?: unknown;
  data?: unknown;
  tag?: unknown;
}

interface RawStoreFile {
  version?: unknown;
  entries?: unknown;
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly paths: KeystorePaths) {}

  async read(): Promise<SecretStoreFile> {
    let text: string;
    try {
      text = await readFile(this.paths.secretsFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
      throw new KeystoreError(
        'invalid-store',
        `failed to read keystore: ${this.paths.secretsFile}`,
        { cause: err },
      );
    }

    let parsed: RawStoreFile;
    try {
      parsed = JSON.parse(text) as RawStoreFile;
    } catch (err) {
      throw new KeystoreError(
        'invalid-store',
        `keystore is not valid JSON: ${this.paths.secretsFile}`,
        { cause: err },
      );
    }
    if (parsed.version !== 1 && parsed.version !== 2) {
      throw new KeystoreError(
        'invalid-store',
        `unsupported keystore version: ${String(parsed.version)}`,
      );
    }
    if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new KeystoreError('invalid-store', `keystore entries are invalid: ${this.paths.secretsFile}`);
    }

    const entries: Record<string, SecretEnvelope> = {};
    for (const [id, raw] of Object.entries(parsed.entries as Record<string, unknown>)) {
      entries[id] = normalizeEnvelope(raw, parsed.version);
    }
    return { version: 2, entries };
  }

  async write(store: SecretStoreFile): Promise<void> {
    await writeFileAtomic(this.paths.secretsFile, `${JSON.stringify(store, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

function normalizeEnvelope(raw: unknown, version: 1 | 2): SecretEnvelope {
  if (!raw || typeof raw !== 'object') throw invalidEnvelope();
  const candidate = raw as RawEnvelope;
  if (
    typeof candidate.iv !== 'string' ||
    typeof candidate.data !== 'string' ||
    typeof candidate.tag !== 'string'
  ) {
    throw invalidEnvelope();
  }

  let keyId: KeystoreKeyId = 'legacy-v1';
  if (version === 2) {
    if (
      candidate.keyId !== 'env-v2' &&
      candidate.keyId !== 'local-v2' &&
      candidate.keyId !== 'legacy-v1'
    ) {
      throw invalidEnvelope();
    }
    keyId = candidate.keyId;
  }
  return { keyId, iv: candidate.iv, data: candidate.data, tag: candidate.tag };
}

function invalidEnvelope(): KeystoreError {
  return new KeystoreError('invalid-store', 'keystore contains an invalid secret envelope');
}

function emptyStore(): SecretStoreFile {
  return { version: 2, entries: {} };
}
