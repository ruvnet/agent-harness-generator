// SPDX-License-Identifier: MIT
//
// MetaHarness orchestration contract for execution-state unlearning.
// Core Memory owns durable forget and selective-replay evidence. MetaHarness owns
// host inventory, orchestration, and adversarial verification across runtimes.

import { hashJson } from './core.js';

export type UnlearningStatus = 'PASS' | 'FAIL' | 'INCOMPLETE';

export type RuntimeStateKind =
  | 'model-context'
  | 'summary'
  | 'plan'
  | 'retrieval-cache'
  | 'tool-session'
  | 'browser-state'
  | 'subprocess'
  | 'filesystem'
  | 'kv-cache'
  | 'provider-cache'
  | 'other';

export interface HostStateSurface {
  id: string;
  kind: RuntimeStateKind;
  observable: boolean;
  purgeable: boolean;
  replayable: boolean;
  remote: boolean;
  notes?: string;
}

export interface HostStateInventory {
  hostId: string;
  hostVersion: string;
  runtimeDigest: string;
  surfaces: HostStateSurface[];
}

export interface UnlearningProbeResult {
  id: string;
  kind: 'explicit' | 'behavioral' | 'retrieval' | 'tool' | 'delegation' | 'resume';
  leaked: boolean;
  evidenceDigest: string;
}

export interface ExecutionUnlearningLifecycleInput {
  coreMemoryPlanDigest: string;
  coreMemoryReceiptDigest: string;
  inventory: HostStateInventory;
  purgedSurfaceIds: string[];
  replayedSurfaceIds: string[];
  probeResults: UnlearningProbeResult[];
  utilityBefore?: number;
  utilityAfter?: number;
}

export interface ExecutionUnlearningLifecycleReceipt {
  version: 1;
  authority: 'none';
  status: UnlearningStatus;
  hostId: string;
  hostVersion: string;
  runtimeDigest: string;
  coreMemoryPlanDigest: string;
  coreMemoryReceiptDigest: string;
  inventoryDigest: string;
  unobservableSurfaceIds: string[];
  unpurgeableSurfaceIds: string[];
  missingPurgeSurfaceIds: string[];
  missingReplaySurfaceIds: string[];
  leakedProbeIds: string[];
  utilityDelta: number | null;
  digest: string;
}

const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:/-]{1,180}$/;
const MAX_SURFACES = 128;
const MAX_PROBES = 512;

function assertDigest(value: string, name: string): void {
  if (!HEX64.test(value)) throw new Error(`${name} must be a lowercase sha256 digest`);
}

function assertId(value: string, name: string): void {
  if (!ID.test(value)) throw new Error(`${name} is invalid`);
}

function uniqueSorted(values: string[], name: string): string[] {
  const set = new Set<string>();
  for (const value of values) {
    assertId(value, name);
    if (set.has(value)) throw new Error(`duplicate ${name}: ${value}`);
    set.add(value);
  }
  return [...set].sort();
}

function normalizedInventory(inventory: HostStateInventory): HostStateInventory {
  assertId(inventory.hostId, 'hostId');
  if (!inventory.hostVersion || inventory.hostVersion.length > 120) throw new Error('hostVersion is invalid');
  assertDigest(inventory.runtimeDigest, 'runtimeDigest');
  if (!Array.isArray(inventory.surfaces) || inventory.surfaces.length === 0 || inventory.surfaces.length > MAX_SURFACES) {
    throw new Error(`inventory must contain 1..${MAX_SURFACES} surfaces`);
  }
  const ids = new Set<string>();
  const surfaces = inventory.surfaces.map((surface) => {
    assertId(surface.id, 'surface id');
    if (ids.has(surface.id)) throw new Error(`duplicate surface id: ${surface.id}`);
    ids.add(surface.id);
    return { ...surface };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { ...inventory, surfaces };
}

function normalizedProbes(probes: UnlearningProbeResult[]): UnlearningProbeResult[] {
  if (!Array.isArray(probes) || probes.length > MAX_PROBES) throw new Error(`at most ${MAX_PROBES} probes are supported`);
  const ids = new Set<string>();
  return probes.map((probe) => {
    assertId(probe.id, 'probe id');
    assertDigest(probe.evidenceDigest, 'probe evidence digest');
    if (ids.has(probe.id)) throw new Error(`duplicate probe id: ${probe.id}`);
    ids.add(probe.id);
    return { ...probe };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Build a host-level unlearning receipt around Core Memory's durable forget and
 * execution-unlearning receipt. PASS is possible only when every declared state
 * surface is observable, purgeable, actually purged, replayed when required, and
 * every adversarial probe is clean. Opaque provider state therefore yields
 * INCOMPLETE rather than a false success claim.
 */
export function evaluateExecutionUnlearningLifecycle(
  input: ExecutionUnlearningLifecycleInput,
): ExecutionUnlearningLifecycleReceipt {
  assertDigest(input.coreMemoryPlanDigest, 'coreMemoryPlanDigest');
  assertDigest(input.coreMemoryReceiptDigest, 'coreMemoryReceiptDigest');
  const inventory = normalizedInventory(input.inventory);
  const probes = normalizedProbes(input.probeResults);
  const purged = uniqueSorted(input.purgedSurfaceIds, 'purged surface id');
  const replayed = uniqueSorted(input.replayedSurfaceIds, 'replayed surface id');
  const known = new Set(inventory.surfaces.map((surface) => surface.id));
  for (const id of [...purged, ...replayed]) {
    if (!known.has(id)) throw new Error(`unknown surface id: ${id}`);
  }

  const unobservableSurfaceIds = inventory.surfaces.filter((s) => !s.observable).map((s) => s.id);
  const unpurgeableSurfaceIds = inventory.surfaces.filter((s) => !s.purgeable).map((s) => s.id);
  const missingPurgeSurfaceIds = inventory.surfaces.filter((s) => s.purgeable && !purged.includes(s.id)).map((s) => s.id);
  const missingReplaySurfaceIds = inventory.surfaces.filter((s) => s.replayable && !replayed.includes(s.id)).map((s) => s.id);
  const leakedProbeIds = probes.filter((probe) => probe.leaked).map((probe) => probe.id);

  const hasLeakOrMissing = leakedProbeIds.length > 0 || missingPurgeSurfaceIds.length > 0 || missingReplaySurfaceIds.length > 0;
  const hasOpaqueState = unobservableSurfaceIds.length > 0 || unpurgeableSurfaceIds.length > 0;
  const status: UnlearningStatus = hasLeakOrMissing ? 'FAIL' : hasOpaqueState ? 'INCOMPLETE' : 'PASS';

  const before = input.utilityBefore;
  const after = input.utilityAfter;
  if (before !== undefined && (!Number.isFinite(before) || before < 0 || before > 1)) throw new Error('utilityBefore must be in [0,1]');
  if (after !== undefined && (!Number.isFinite(after) || after < 0 || after > 1)) throw new Error('utilityAfter must be in [0,1]');
  const utilityDelta = before === undefined || after === undefined ? null : Number((after - before).toFixed(6));

  const payload = {
    version: 1 as const,
    authority: 'none' as const,
    status,
    hostId: inventory.hostId,
    hostVersion: inventory.hostVersion,
    runtimeDigest: inventory.runtimeDigest,
    coreMemoryPlanDigest: input.coreMemoryPlanDigest,
    coreMemoryReceiptDigest: input.coreMemoryReceiptDigest,
    inventoryDigest: hashJson(inventory),
    unobservableSurfaceIds,
    unpurgeableSurfaceIds,
    missingPurgeSurfaceIds,
    missingReplaySurfaceIds,
    leakedProbeIds,
    utilityDelta,
  };
  return { ...payload, digest: hashJson(payload) };
}
