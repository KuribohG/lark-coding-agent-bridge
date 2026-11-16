import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

type NonceState = 'used' | 'revoked';
interface NonceRecord { state: NonceState; at: number }

/** Longer than any callback token lives, so a recorded nonce still forbids a replay while its token is valid. */
const NONCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The map is compacted once it grows past this, instead of only at load. */
const NONCE_PRUNE_AT = 512;

export class CallbackNonceStore {
  private readonly path: string;
  private readonly nonces = new Map<string, NonceRecord>();
  private saving: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return;
      this.nonces.clear();
      const now = Date.now();
      for (const [nonce, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value === 'used' || value === 'revoked') {
          // Written before records carried a time; its token has certainly passed its own expiry by now.
          this.nonces.set(nonce, { state: value, at: now });
        } else if (value && typeof value === 'object') {
          const record = value as Partial<NonceRecord>;
          if ((record.state === 'used' || record.state === 'revoked') && typeof record.at === 'number') {
            this.nonces.set(nonce, { state: record.state, at: record.at });
          }
        }
      }
      this.prune(now);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.fail('callback-nonce', err, { step: 'load' });
    }
  }

  state(nonce: string): NonceState | undefined {
    return this.nonces.get(nonce)?.state;
  }

  consume(nonce: string): boolean {
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, { state: 'used', at: Date.now() });
    this.pruneIfDue();
    this.schedulePersist();
    return true;
  }

  revoke(nonce: string): void {
    this.nonces.set(nonce, { state: 'revoked', at: Date.now() });
    this.pruneIfDue();
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private pruneIfDue(): void {
    if (this.nonces.size > NONCE_PRUNE_AT) this.prune(Date.now());
  }

  /** Drops records that cannot forbid a replay any more, even if their token were somehow still accepted. */
  private prune(now: number): void {
    for (const [nonce, record] of this.nonces) if (now - record.at > NONCE_RETENTION_MS) this.nonces.delete(nonce);
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(
          this.path,
          `${JSON.stringify(Object.fromEntries(this.nonces), null, 2)}\n`,
          { mode: 0o600 },
        );
      })
      .catch((err: unknown) => {
        log.fail('callback-nonce', err, { step: 'persist' });
      });
  }
}
