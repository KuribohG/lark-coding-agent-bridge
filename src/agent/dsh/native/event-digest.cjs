'use strict';
const { createHash } = require('node:crypto');
const { canonicalJson } = require('./utilities.cjs');
const algorithm = 'sha256-event-chain-v1';
const empty = createHash('sha256').update('warp-assistant-native-events-v1').digest('hex');
const extend = (previous, event) => createHash('sha256').update(Buffer.from(previous, 'hex')).update(canonicalJson(event)).digest('hex');
function digestEvents(events, selected) {
  if (!selected) return createHash('sha256').update(canonicalJson(events)).digest('hex'); // existing handles
  if (selected !== algorithm) throw Object.assign(new Error('Unsupported native checkpoint digest.'), { code: 'harness-incompatible' });
  let value = empty;
  for (const event of events) value = extend(value, event);
  return value;
}
module.exports = { algorithm, empty, extend, digestEvents };
