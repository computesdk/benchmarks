import { writeFileSync } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { computeStats } from '../src/util/stats.js';
import type { DatabaseClient, DatabaseDocument, DatabaseBenchmarkResult } from './types.js';

interface StepContext {
  step<R>(name: string, fn: () => Promise<R> | R): Promise<R>;
  cleanup(fn: () => Promise<unknown> | unknown): Promise<unknown>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundStats(stats: { median: number; p95: number; p99: number }) {
  return {
    median: round(stats.median),
    p95: round(stats.p95),
    p99: round(stats.p99),
  };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 15);
}

function makePayload(size: number): string {
  const bytes = Math.ceil(size * 3 / 4);
  return Buffer.from(crypto.randomBytes(bytes)).toString('base64').slice(0, size);
}

function assertDocument(actual: DatabaseDocument | null, expected: DatabaseDocument, phase: string): void {
  if (
    !actual ||
    actual.id !== expected.id ||
    actual.name !== expected.name ||
    actual.payload !== expected.payload ||
    actual.version !== expected.version
  ) {
    throw new Error(`${phase} verification failed`);
  }
}

export async function runCrudCycle(
  client: DatabaseClient,
  ctx: StepContext,
  payloadBytes: number,
) {
  const totalStart = performance.now();
  const id = `benchmark-${Date.now()}-${randomId()}`;
  const payload = makePayload(payloadBytes);
  const updatedPayload = makePayload(payloadBytes);
  const document: DatabaseDocument = { id, name: 'database benchmark', payload, version: 1 };
  const updatedDocument: DatabaseDocument = {
    ...document,
    name: 'database benchmark updated',
    payload: updatedPayload,
    version: 2,
  };

  try {
    const createStart = performance.now();
    await ctx.step('create', () => client.create(document));
    const createMs = performance.now() - createStart;

    const readStart = performance.now();
    const readDocument = await ctx.step('read', () => client.read(id));
    const readMs = performance.now() - readStart;
    assertDocument(readDocument, document, 'create/read');

    const updateStart = performance.now();
    await ctx.step('update', () => client.update(id, {
      name: updatedDocument.name,
      payload: updatedDocument.payload,
      version: updatedDocument.version,
    }));
    const updateMs = performance.now() - updateStart;

    const readAfterUpdateStart = performance.now();
    const readAfterUpdateDocument = await ctx.step('read-after-update', () => client.read(id));
    const readAfterUpdateMs = performance.now() - readAfterUpdateStart;
    assertDocument(readAfterUpdateDocument, updatedDocument, 'update/read');

    const deleteStart = performance.now();
    const deleted = await ctx.step('delete', () => client.delete(id));
    const deleteMs = performance.now() - deleteStart;
    if (deleted !== 1) {
      throw new Error(`delete verification failed: removed ${deleted} rows`);
    }

    return {
      createMs,
      readMs,
      updateMs,
      readAfterUpdateMs,
      deleteMs,
      totalMs: performance.now() - totalStart,
      payloadBytes,
    };
  } catch (error) {
    try {
      await ctx.cleanup(() => client.delete(id));
    } catch {
      // Best-effort cleanup after a failed cycle.
    }
    throw error;
  }
}

export async function writeDatabaseResultsJson(
  results: DatabaseBenchmarkResult[],
  outPath: string,
): Promise<void> {
  const cleanResults = results.map((result) => ({
    provider: result.provider,
    mode: result.mode,
    table: result.table,
    payloadBytes: result.payloadBytes,
    iterations: result.iterations.map((iteration) => ({
      createMs: round(iteration.createMs),
      readMs: round(iteration.readMs),
      updateMs: round(iteration.updateMs),
      readAfterUpdateMs: round(iteration.readAfterUpdateMs),
      deleteMs: round(iteration.deleteMs),
      totalMs: round(iteration.totalMs),
      payloadBytes: iteration.payloadBytes,
      ...(iteration.error ? { error: iteration.error } : {}),
    })),
    summary: {
      createMs: roundStats(result.summary.createMs),
      readMs: roundStats(result.summary.readMs),
      updateMs: roundStats(result.summary.updateMs),
      readAfterUpdateMs: roundStats(result.summary.readAfterUpdateMs),
      deleteMs: roundStats(result.summary.deleteMs),
      totalMs: roundStats(result.summary.totalMs),
    },
    ...(result.compositeScore !== undefined ? { compositeScore: round(result.compositeScore) } : {}),
    ...(result.successRate !== undefined ? { successRate: round(result.successRate) } : {}),
    ...(result.skipped ? { skipped: result.skipped, skipReason: result.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: {
      iterations: results[0]?.iterations.length || 0,
      timeoutMs: 30_000,
    },
    results: cleanResults,
  };
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
