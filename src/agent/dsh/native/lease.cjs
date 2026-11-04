'use strict';
const fs = require('node:fs/promises');
const { realpathSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { renameWithRetry } = require('./utilities.cjs');
// OS ownership survives stale files and is released on process death. Windows
// share=0 excludes other logon sessions too, unlike a Local named semaphore.
async function acquireRootLease(home, load) {
  await fs.mkdir(home, { recursive: true });
  const root = realpathSync.native(home), filename = path.join(root, 'writer.lock');
  let release, loginSession, deployment, sharingRetries = 0;
  if (process.platform === 'win32') {
    const { default: koffi } = await load('koffi');
    const kernel = koffi.load('kernel32.dll');
    const create = kernel.func('__stdcall', 'CreateFileW', 'intptr', ['str16', 'uint', 'uint', 'void*', 'uint', 'uint', 'intptr']);
    const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
    const lastError = kernel.func('__stdcall', 'GetLastError', 'uint', []);
    const volumePath = kernel.func('__stdcall', 'GetVolumePathNameW', 'int', ['str16', 'void*', 'uint']);
    const driveType = kernel.func('__stdcall', 'GetDriveTypeW', 'uint', ['str16']);
    const volumeInfo = kernel.func('__stdcall', 'GetVolumeInformationW', 'int', ['str16', 'void*', 'uint', 'void*', 'void*', 'void*', 'void*', 'uint']);
    const device = kernel.func('__stdcall', 'QueryDosDeviceW', 'uint', ['str16', 'void*', 'uint']);
    const mountBuffer = Buffer.alloc(65536), filesystemBuffer = Buffer.alloc(128), deviceBuffer = Buffer.alloc(65536);
    const decode = buffer => buffer.toString('utf16le').split('\0')[0];
    const originalRoot = path.parse(path.resolve(home).replace(/^\\\\\?\\/, '')).root;
    const drive = originalRoot.replace(/\\$/, '');
    if (!volumePath(path.toNamespacedPath(root), mountBuffer, 32768) || !/^[a-z]:$/i.test(drive)
        || !device(drive, deviceBuffer, 32768) || decode(deviceBuffer).startsWith('\\??\\')
        || driveType(decode(mountBuffer)) !== 3
        || !volumeInfo(decode(mountBuffer), null, 0, null, null, null, filesystemBuffer, 64)
        || decode(filesystemBuffer) !== 'NTFS')
      throw Object.assign(new Error('Native writer deployment is unverified. Use a local fixed NTFS volume in the same Windows logon session; subst, network/UNC and ReFS roots are excluded.'), { code: 'harness-deployment-unverified' });
    deployment = { platform: 'win32', filesystem: 'NTFS', driveType: 'fixed', logonScope: 'same-session' };
    const session = kernel.func('__stdcall', 'ProcessIdToSessionId', 'int', ['uint', '_Out_ uint*']);
    const slot = [0];
    if (!session(process.pid, slot)) throw new Error('Cannot verify Windows logon session for native ownership.');
    loginSession = String(slot[0]);
    let handle, errorCode;
    const deadline = Date.now() + 300;
    while (true) {
      handle = create(path.toNamespacedPath(filename), 0xc0000000, 0, null, 4, 0x80, 0);
      if (handle !== -1 && handle !== -1n) break;
      errorCode = lastError();
      if (![32, 33].includes(errorCode) || Date.now() >= deadline) throw Object.assign(new Error(`Native root is owned or inaccessible after ${sharingRetries} bounded sharing retries (Win32 ${errorCode}). Close the other owner before retrying.`), { code: 'harness-root-owned', sharingRetries });
      sharingRetries++; await delay(50);
    }
    release = async () => { if (!close(handle)) throw new Error('Failed to release native root lease.'); };
  } else {
    const { tryLockExclusive } = await load('@deepseek-ai/node-addon-system/flock');
    const stream = await fs.open(filename, 'a+');
    try { await tryLockExclusive(stream.fd); }
    catch (cause) { await stream.close(); throw Object.assign(new Error('Native root is already owned.'), { code: 'harness-root-owned', cause }); }
    const held = await stream.stat(), current = await fs.stat(filename);
    if (held.ino !== current.ino || held.dev !== current.dev) { await stream.close(); throw new Error('Native root lock was replaced.'); }
    loginSession = process.env.XDG_SESSION_ID || `uid:${process.getuid?.()}`;
    release = () => stream.close();
  }
  let closed = false;
  try {
    const metadataPath = path.join(root, 'writer.json');
    let previous, metadataRecovery;
    try {
      const bytes = await fs.readFile(metadataPath);
      try {
        previous = JSON.parse(bytes);
        if (!previous || !Number.isSafeInteger(previous.epoch) || previous.epoch < 0 || typeof previous.loginSession !== 'string') throw new Error('Invalid owner metadata.');
      } catch {
        const preservedPath = path.join(root, `writer.corrupt-${randomUUID()}.json`);
        await fs.writeFile(preservedPath, bytes, { flag: 'wx' });
        previous = null; metadataRecovery = { code: 'harness-owner-metadata-recovered', preservedPath, previousEpochKnown: false };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const metadata = { schemaVersion: 1, pid: process.pid, loginSession, epoch: (previous?.epoch || 0) + 1, deployment, sharingRetries,
      acquiredAt: new Date().toISOString(), ...(previous ? { previousOwner: { pid: previous.pid, loginSession: previous.loginSession, epoch: previous.epoch },
        sequentialLoginChange: previous.loginSession !== loginSession } : {}), ...(metadataRecovery ? { metadataRecovery } : {}) };
    // The physical lease proves exclusivity now. Prior logon identity is diagnostic;
    // native event reconciliation still fences any writes made while offline.
    const temporary = `${metadataPath}.${randomUUID()}.tmp`;
    try {
      const descriptor = await fs.open(temporary, 'wx');
      try { await descriptor.writeFile(JSON.stringify(metadata) + '\n'); await descriptor.sync(); } finally { await descriptor.close(); }
      await renameWithRetry(temporary, metadataPath);
    } finally { await fs.rm(temporary, { force: true }); }
    return { root, ...metadata, async close() { if (!closed) { closed = true; await release(); } } };
  } catch (error) { await release(); throw error; }
}
module.exports = { acquireRootLease };
