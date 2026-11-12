import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type Database from 'better-sqlite3';

/** How often the background thread looks for journal pages to move into the database file. */
const INTERVAL_MS = 1_000;
/** WAL size, in pages, above which the thread also makes the next write start the file over, so it stops growing. */
const RESTART_PAGES = 16_384;

// A second connection on its own thread. PASSIVE never waits for the writer, so the slow part (copying and syncing
// pages) runs beside it. Continuous writes can keep the WAL from ever being reused; past RESTART_PAGES a RESTART
// follows, which does hold the writer out, but only for the few pages written since the PASSIVE pass.
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const db = new (require(workerData.module))(workerData.path, { fileMustExist: true, timeout: 2000 });
db.pragma('wal_autocheckpoint = 0');
parentPort.postMessage('ready');
setInterval(() => {
  try {
    const [state] = db.pragma('wal_checkpoint(PASSIVE)');
    if (state.log > workerData.restartPages) db.pragma('wal_checkpoint(RESTART)');
  } catch {}
}, workerData.intervalMs);
`;

/**
 * Moves WAL checkpoints of `db` off the calling thread. SQLite otherwise checkpoints inside whichever commit crosses
 * its page threshold, and on a network filesystem that one commit can block the event loop for over a second.
 * Automatic checkpoints are switched off only once the thread is running, and back on if it fails, so a host where
 * the thread cannot start behaves as before. Returns the function that stops it.
 */
export function checkpointInBackground(db: Database.Database, path: string, failed: (error: unknown) => void): () => void {
  let stopped = false;
  let worker: Worker;
  try {
    worker = new Worker(SOURCE, { eval: true, workerData: { path, intervalMs: INTERVAL_MS, restartPages: RESTART_PAGES,
      module: createRequire(import.meta.url).resolve('better-sqlite3') } });
  } catch (error) { failed(error); return () => {}; }
  worker.unref();
  const automatic = (pages: number) => { if (db.open) db.pragma(`wal_autocheckpoint = ${pages}`); };
  worker.once('message', () => { if (!stopped) automatic(0); });
  worker.once('error', error => { if (!stopped) { automatic(1000); failed(error); } });
  return () => {
    stopped = true;
    automatic(1000);
    void worker.terminate();
  };
}
