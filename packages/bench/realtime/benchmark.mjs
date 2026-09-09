// SPDX-License-Identifier: MIT
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [modulePath, sourcePath, output] = process.argv.slice(2);
if (!modulePath || !sourcePath) throw new Error('usage: benchmark.mjs compiled-module source.ts [report.json]');
const { RealtimeSession } = await import(pathToFileURL(resolve(modulePath)).href);
const seeds = [42, 43, 44, 45, 46];
const perSeed = 200;
const handoff = { version: 1, authority: 'none', session_id: 's', latest_sequence: '1', queued_events: [], interrupt_sequence: '1', cancel_sequence: null, cancelled_work_units: '0', dropped_events: '0' };
function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
function work(ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) done(); else signal?.addEventListener('abort', done, { once: true });
  });
}
function stats(values) {
  const v = [...values].sort((a, b) => a-b), mean = v.reduce((a,b) => a+b, 0)/v.length;
  return { n: v.length, meanUs: mean, p50Us: v[Math.floor(v.length*0.5)], p95Us: v[Math.floor(v.length*0.95)], p99Us: v[Math.floor(v.length*0.99)], stddevUs: Math.sqrt(v.reduce((s,x)=>s+(x-mean)**2,0)/(v.length-1)) };
}
for (let i=0;i<100;i++) {
  const warm = new RealtimeSession('s');
  const turn = warm.start('', async (_, c) => work(0, c.signal));
  warm.acceptHandoff(handoff); await turn.settled;
  const c = new AbortController(); const p = work(0,c.signal); c.abort(); await p;
}
const serial = [], abortOnly = [], bridge = [], bySeed = [];
let suppressed = 0, cleanCorrect = 0;
for (const seed of seeds) {
  const random = rng(seed), s1 = [], s2 = [], s3 = [];
  for (let i=0; i<perSeed; i++) {
    const delayMs = 2 + Math.floor(random()*3);
    let session;
    const arms = [0, 1, 2];
    for (let j=arms.length-1; j>0; j--) { const k=Math.floor(random()*(j+1)); [arms[j],arms[k]]=[arms[k],arms[j]]; }
    for (const arm of arms) {
      if (arm === 0) {
        const pending = work(delayMs), at = performance.now(); await pending; s1.push((performance.now()-at)*1000);
      } else if (arm === 1) {
        const controller = new AbortController(), pending = work(delayMs, controller.signal);
        const at = performance.now(); controller.abort(); s2.push((performance.now()-at)*1000); await pending;
      } else {
        session = new RealtimeSession('s');
        const turn = session.start('', async (_, c) => { await work(delayMs, c.signal); if (!c.emit('obsolete')) suppressed++; return 1; });
        const at = performance.now(); session.acceptHandoff(handoff); s3.push((performance.now()-at)*1000);
        await turn.settled;
        if ((await turn.result).status !== 'cancelled') throw new Error('CANCEL_GATE_FAILED');
      }
    }
    const clean = session.start(String(i), async (input, c) => { const value = Number(input)*17 + 3; c.emit(String(value)); return value; });
    const result = await clean.result; await clean.settled;
    if (result.status === 'completed' && result.value === i*17 + 3) cleanCorrect++;
  }
  serial.push(...s1); abortOnly.push(...s2); bridge.push(...s3);
  bySeed.push({ seed, serial: stats(s1), directAbort: stats(s2), bridge: stats(s3) });
}
const S=stats(serial), A=stats(abortOnly), B=stats(bridge);
const result = {
  schemaVersion:2, experimentFamily:'realtime-randomized-arm-order-v2', classification:'local deterministic asynchronous workload, not model-quality reproduction',
  runtime: { node:process.version, v8:process.versions.v8, os:os.platform(), release:os.release(), architecture:os.arch(), cpu:os.cpus()[0]?.model, logicalCpus:os.cpus().length },
  sourceSha256:createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
  seeds, samples:seeds.length*perSeed, workload:'cooperative 2..4ms reasoner, identical per-seed work; interrupt immediately after start; one active generation per session',
  baseline:S, simplerAblation:A, candidate:B, perSeed:bySeed,
  measured:{ meanAckReductionPercent:100*(S.meanUs-B.meanUs)/S.meanUs, p95AckReductionPercent:100*(S.p95Us-B.p95Us)/S.p95Us, bridgeOverheadVsDirectAbortUs:B.meanUs-A.meanUs, obsoleteOutputsSuppressed:suppressed, expectedSuppressed:1000, cleanTaskCorrect:cleanCorrect, cleanTaskTotal:1000 },
  resourceCosts:{ modelCalls:0, billedModelCostUsd:0, energyJoules:null, providerGpuWaste:null },
  gates:{ syntheticAck: B.p95Us < 0.6*S.p95Us, staleOutputSuppression:suppressed===1000, deterministicQuality:cleanCorrect===1000, realModelQuality:'NOT_RUN', remoteProviderWaste:'NOT_MEASURED' },
  negativeResult:'Direct AbortController achieves the same architectural latency improvement with fewer guarantees. No latency superiority over that simpler ablation is claimed. The bridge adds scope validation, generation fencing, bounded work and effect guards.',
};
if(output) writeFileSync(output, JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(!result.gates.syntheticAck||!result.gates.staleOutputSuppression||!result.gates.deterministicQuality) process.exitCode=1;
