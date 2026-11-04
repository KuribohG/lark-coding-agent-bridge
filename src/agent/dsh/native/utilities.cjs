'use strict';
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const canonicalJson = value => JSON.stringify(canonical(value));
const silentTrace = Object.freeze({ mark() {}, begin() {}, end() {} });
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 3) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}
module.exports = { canonicalJson, silentTrace, renameWithRetry };
