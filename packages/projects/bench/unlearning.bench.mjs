import { performance } from 'node:perf_hooks';
import { evaluateExecutionUnlearningLifecycle } from '../dist/unlearning.js';

const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const D3 = '3'.repeat(64);
const surfaces = Array.from({ length: 32 }, (_, i) => ({
  id: `surface-${i}`,
  kind: i % 3 === 0 ? 'retrieval-cache' : i % 3 === 1 ? 'tool-session' : 'model-context',
  observable: true,
  purgeable: true,
  replayable: i % 3 !== 1,
  remote: false,
}));
const input = {
  coreMemoryPlanDigest: D1,
  coreMemoryReceiptDigest: D2,
  inventory: { hostId: 'bench-host', hostVersion: '1', runtimeDigest: D3, surfaces },
  purgedSurfaceIds: surfaces.map((s) => s.id),
  replayedSurfaceIds: surfaces.filter((s) => s.replayable).map((s) => s.id),
  probeResults: Array.from({ length: 12 }, (_, i) => ({ id: `probe-${i}`, kind: 'behavioral', leaked: false, evidenceDigest: D1 })),
};

for (let i = 0; i < 100; i += 1) evaluateExecutionUnlearningLifecycle(input);
const n = 10000;
const start = performance.now();
for (let i = 0; i < n; i += 1) evaluateExecutionUnlearningLifecycle(input);
const elapsed = performance.now() - start;
console.log(JSON.stringify({ benchmark: 'execution-unlearning-receipt', iterations: n, totalMs: elapsed, usPerReceipt: (elapsed * 1000) / n }));
