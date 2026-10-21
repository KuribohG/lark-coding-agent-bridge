import { paths } from './paths';
import { decryptSecret, encryptSecret } from './keystore/crypto';
import { FileSecretStore } from './keystore/file-store';
import {
  KeystoreKeyProvider,
  clearDerivedKeyCache,
  derivedKeyCacheSize,
} from './keystore/key-provider';
import {
  KeystoreError,
  type KeystorePaths,
  type KeystoreRuntimeOptions,
  type SecretEnvelope,
  type SecretKeyProvider,
  type SecretStoreFile,
} from './keystore/types';

export type { KeystorePaths, KeystoreRuntimeOptions } from './keystore/types';

/**
 * Public keystore facade. Storage, key resolution and cryptography live in
 * separate modules so callers only depend on secret get/set/remove/list.
 */
export async function getSecret(
  id: string,
  storePaths: KeystorePaths = paths,
  options: KeystoreRuntimeOptions = {},
): Promise<string | undefined> {
  const secrets = new FileSecretStore(storePaths);
  const store = await secrets.read();
  const envelope = store.entries[id];
  if (!envelope) return undefined;
  const provider = new KeystoreKeyProvider(storePaths, options);
  const active = await provider.activeKey();
  if (envelope.keyId === active.id) return decryptEnvelope(id, envelope, provider);

  // A successful legacy read is the last safe migration point: the old key is
  // known to work now, but a future hostname change may remove it.
  const plaintext = await decryptEnvelope(id, envelope, provider);
  await migrateDecryptableEntries(store, provider, active.id, active.key);
  await secrets.write(store);
  return plaintext;
}

export async function setSecret(
  id: string,
  plaintext: string,
  storePaths: KeystorePaths = paths,
  options: KeystoreRuntimeOptions = {},
): Promise<void> {
  const provider = new KeystoreKeyProvider(storePaths, options);
  const active = await provider.activeKey();
  const secrets = new FileSecretStore(storePaths);
  const store = await secrets.read();
  await migrateDecryptableEntries(store, provider, active.id, active.key);
  store.entries[id] = encryptSecret(active.key, plaintext, active.id);
  await secrets.write(store);
}

export async function removeSecret(
  id: string,
  storePaths: KeystorePaths = paths,
): Promise<boolean> {
  const secrets = new FileSecretStore(storePaths);
  const store = await secrets.read();
  if (!(id in store.entries)) return false;
  delete store.entries[id];
  await secrets.write(store);
  return true;
}

export async function listSecretIds(storePaths: KeystorePaths = paths): Promise<string[]> {
  const store = await new FileSecretStore(storePaths).read();
  return Object.keys(store.entries);
}

export function clearKeystoreDerivedKeyCache(): void {
  clearDerivedKeyCache();
}

export function keystoreDerivedKeyCacheSize(): number {
  return derivedKeyCacheSize();
}

async function migrateDecryptableEntries(
  store: SecretStoreFile,
  provider: SecretKeyProvider,
  activeId: SecretEnvelope['keyId'],
  activeKey: Buffer,
): Promise<void> {
  for (const [id, envelope] of Object.entries(store.entries)) {
    if (envelope.keyId === activeId) continue;
    try {
      const plaintext = await decryptEnvelope(id, envelope, provider);
      store.entries[id] = encryptSecret(activeKey, plaintext, activeId);
    } catch (err) {
      // Legacy data encrypted under an unavailable old hostname cannot be
      // migrated. Leave it intact; reading that secret still fails with a
      // precise key/decryption error.
      if (!(err instanceof KeystoreError)) throw err;
    }
  }
}

async function decryptEnvelope(
  id: string,
  envelope: SecretEnvelope,
  provider: SecretKeyProvider,
): Promise<string> {
  const material = await provider.keyFor(envelope.keyId);
  try {
    return decryptSecret(material.key, envelope);
  } catch (err) {
    throw new KeystoreError(
      'decrypt-failed',
      `failed to decrypt secret ${id} with ${envelope.keyId}; the key may have changed`,
      { cause: err },
    );
  }
}
