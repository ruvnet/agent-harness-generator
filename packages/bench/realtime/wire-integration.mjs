// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [modulePath, fixturesPath] = process.argv.slice(2);
if (!modulePath || !fixturesPath) throw new Error('usage: wire-integration.mjs compiled-module fixtures.jsonl');
if (statSync(fixturesPath).size > 1_048_576) throw new Error('FIXTURE_SIZE_LIMIT');
const { RealtimeSession } = await import(pathToFileURL(resolve(modulePath)).href);
const lines = readFileSync(fixturesPath, 'utf8').trim().split('\n');
assert.equal(lines.length, 1000);
let stopped = 0, lateOutputsBlocked = 0, highPrecision = 0;
for (const [index, line] of lines.entries()) {
  const handoff = JSON.parse(line);
  assert.equal(handoff.session_id, `s${index}`);
  assert.equal(handoff.queued_events.length, 1);
  assert.equal(handoff.queued_events[0].kind, 'Observation');
  if (BigInt(handoff.latest_sequence) > BigInt(Number.MAX_SAFE_INTEGER)) highPrecision++;
  let release;
  const delayed = new Promise(r => { release = r; });
  const tokens = [];
  const session = new RealtimeSession(`s${index}`, { onToken: text => tokens.push(text) });
  const turn = session.start('synthetic task', async (_, context) => {
    await delayed;
    if (!context.emit('obsolete')) lateOutputsBlocked++;
    return 'obsolete';
  });
  const receipt = session.acceptHandoff(handoff);
  assert.equal(receipt.acknowledged, true);
  assert.equal(receipt.authority, 'none');
  assert.equal(turn.signal.aborted, true);
  assert.equal((await turn.result).status, 'cancelled');
  release();
  await turn.settled;
  assert.equal(await session.waitForQuiescence(), 'STOPPED');
  assert.deepEqual(tokens, []);
  assert.equal(session.acceptHandoff(handoff).status, 'stale');
  stopped++;
}
assert.equal(stopped, 1000);
assert.equal(lateOutputsBlocked, 1000);
assert.ok(highPrecision > 300);
console.log(JSON.stringify({ schemaVersion: 1, authority: 'none', fixtureSource: 'compiled pinned MidStream ReflexController', sessions: stopped, queueSaturatedInEverySession: true, lateOutputsBlocked, highPrecisionSequences: highPrecision, opaqueProviderCancellation: 'NOT_MEASURED', verdict: 'PASS_LOCAL_WIRE_CONTRACT' }, null, 2));
