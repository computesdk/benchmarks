import fs from 'fs';
import type { FsProviderConfig, FsBenchmarkResult, FsTimingResult } from './types.js';
import { withTimeout } from '../util/timeout.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeStats(values: number[]): { median: number; p95: number; p99: number } {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  return {
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
  };
}

function parseMetrics(stdout: string): Omit<FsTimingResult, 'error'> {
  const lastLine = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  if (!lastLine) {
    throw new Error('FS benchmark command produced empty output');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new Error(`Unable to parse FS benchmark output: ${lastLine.slice(0, 200)}`);
  }

  return {
    writeMs: Number(parsed.writeMs || 0),
    readMs: Number(parsed.readMs || 0),
    smallFileOpsMs: Number(parsed.smallFileOpsMs || 0),
    metadataOpsMs: Number(parsed.metadataOpsMs || 0),
    writeMbps: Number(parsed.writeMbps || 0),
    readMbps: Number(parsed.readMbps || 0),
    fileSizeBytes: Number(parsed.fileSizeBytes || 0),
    smallFilesCount: Number(parsed.smallFilesCount || 0),
  };
}

function buildFsWorkloadCommand(fileSizeBytes: number, smallFilesCount: number): string {
  const nodeScript = [
    'const fsp=require("fs/promises");',
    'const path=require("path");',
    'const os=require("os");',
    `const size=${fileSizeBytes};`,
    `const count=${smallFilesCount};`,
    'const root=path.join(os.tmpdir(),`fs-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`);',
    'const bigFile=path.join(root,"payload.bin");',
    'const smallDir=path.join(root,"small");',
    'const metaDir=path.join(root,"meta");',
    'const nowMs=()=>Number(process.hrtime.bigint())/1e6;',
    '(async()=>{',
    'await fsp.mkdir(root,{recursive:true});',
    'const payload=Buffer.alloc(size,120);',
    'const writeStart=nowMs();',
    'await fsp.writeFile(bigFile,payload);',
    'const writeMs=nowMs()-writeStart;',
    'const readStart=nowMs();',
    'const buf=await fsp.readFile(bigFile);',
    'const readMs=nowMs()-readStart;',
    'if(buf.length!==size) throw new Error(`read size mismatch: ${buf.length} != ${size}`);',
    'await fsp.mkdir(smallDir,{recursive:true});',
    'const smallStart=nowMs();',
    'for(let i=0;i<count;i++){await fsp.writeFile(path.join(smallDir,`f-${i}.txt`),"hello-benchmark");}',
    'for(let i=0;i<count;i++){await fsp.readFile(path.join(smallDir,`f-${i}.txt`));}',
    'for(let i=0;i<count;i++){await fsp.unlink(path.join(smallDir,`f-${i}.txt`));}',
    'const smallFileOpsMs=nowMs()-smallStart;',
    'await fsp.mkdir(metaDir,{recursive:true});',
    'const metaA=path.join(metaDir,"a.txt");',
    'const metaB=path.join(metaDir,"b.txt");',
    'await fsp.writeFile(metaA,"meta");',
    'const metaStart=nowMs();',
    'for(let i=0;i<100;i++){await fsp.stat(metaA); await fsp.rename(metaA,metaB); await fsp.rename(metaB,metaA);}',
    'await fsp.unlink(metaA);',
    'const metadataOpsMs=nowMs()-metaStart;',
    'const writeMbps=(size*8)/(writeMs/1000)/1_000_000;',
    'const readMbps=(size*8)/(readMs/1000)/1_000_000;',
    'console.log(JSON.stringify({writeMs,readMs,smallFileOpsMs,metadataOpsMs,writeMbps,readMbps,fileSizeBytes:size,smallFilesCount:count}));',
    'await fsp.rm(root,{recursive:true,force:true});',
    '})().catch(async(err)=>{try{await fsp.rm(root,{recursive:true,force:true});}catch{} console.error(err?.message||String(err)); process.exit(1);});',
  ].join('');

  return `node -e '${nodeScript}'`;
}

async function runFsIteration(
  compute: any,
  timeout: number,
  fileSizeBytes: number,
  smallFilesCount: number,
  sandboxOptions?: Record<string, any>,
  destroyTimeoutMs: number = 15000,
): Promise<FsTimingResult> {
  let sandbox: any = null;

  try {
    sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
    const command = buildFsWorkloadCommand(fileSizeBytes, smallFilesCount);
    const result = await withTimeout(
      sandbox.runCommand(command),
      timeout,
      'FS benchmark workload timed out',
    ) as { exitCode: number; stdout?: string; stderr?: string };

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Command failed with exit code ${result.exitCode}`);
    }

    return parseMetrics(result.stdout || '');
  } finally {
    if (sandbox) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sandbox.destroy(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Destroy timeout')), destroyTimeoutMs);
          }),
        ]);
      } catch (err) {
        console.warn(`    [cleanup] destroy failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
}

export async function runFsBenchmark(
  config: FsProviderConfig,
  fileSizeBytes: number,
  smallFilesCount: number,
): Promise<FsBenchmarkResult> {
  const { name, iterations = 50, timeout = 120000, requiredEnvVars, createCompute, sandboxOptions, destroyTimeoutMs } = config;
  const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'fs',
      fileSizeBytes,
      smallFilesCount,
      iterations: [],
      summary: {
        writeMs: { median: 0, p95: 0, p99: 0 },
        readMs: { median: 0, p95: 0, p99: 0 },
        smallFileOpsMs: { median: 0, p95: 0, p99: 0 },
        metadataOpsMs: { median: 0, p95: 0, p99: 0 },
        writeMbps: { median: 0, p95: 0, p99: 0 },
        readMbps: { median: 0, p95: 0, p99: 0 },
      },
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = createCompute();
  const results: FsTimingResult[] = [];

  console.log(`\n--- FS Benchmarking: ${name} (${iterations} iterations) ---`);
  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    try {
      const iteration = await runFsIteration(compute, timeout, fileSizeBytes, smallFilesCount, sandboxOptions, destroyTimeoutMs);
      results.push(iteration);
      console.log(`    Read: ${(iteration.readMs / 1000).toFixed(2)}s, Write: ${(iteration.writeMs / 1000).toFixed(2)}s, Read Mbps: ${iteration.readMbps.toFixed(2)}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`    FAILED: ${error}`);
      results.push({
        writeMs: 0,
        readMs: 0,
        smallFileOpsMs: 0,
        metadataOpsMs: 0,
        writeMbps: 0,
        readMbps: 0,
        fileSizeBytes,
        smallFilesCount,
        error,
      });
    }
  }

  const successful = results.filter((r) => !r.error);
  return {
    provider: name,
    mode: 'fs',
    fileSizeBytes,
    smallFilesCount,
    iterations: results,
    summary: {
      writeMs: computeStats(successful.map((r) => r.writeMs)),
      readMs: computeStats(successful.map((r) => r.readMs)),
      smallFileOpsMs: computeStats(successful.map((r) => r.smallFileOpsMs)),
      metadataOpsMs: computeStats(successful.map((r) => r.metadataOpsMs)),
      writeMbps: computeStats(successful.map((r) => r.writeMbps)),
      readMbps: computeStats(successful.map((r) => r.readMbps)),
    },
  };
}

function roundStats(s: { median: number; p95: number; p99: number }) {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export async function writeFsResultsJson(results: FsBenchmarkResult[], outPath: string): Promise<void> {
  const os = await import('os');

  const cleanResults = results.map((r) => ({
    provider: r.provider,
    mode: r.mode,
    fileSizeBytes: r.fileSizeBytes,
    smallFilesCount: r.smallFilesCount,
    iterations: r.iterations.map((i) => ({
      writeMs: round(i.writeMs),
      readMs: round(i.readMs),
      smallFileOpsMs: round(i.smallFileOpsMs),
      metadataOpsMs: round(i.metadataOpsMs),
      writeMbps: round(i.writeMbps),
      readMbps: round(i.readMbps),
      fileSizeBytes: i.fileSizeBytes,
      smallFilesCount: i.smallFilesCount,
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      writeMs: roundStats(r.summary.writeMs),
      readMs: roundStats(r.summary.readMs),
      smallFileOpsMs: roundStats(r.summary.smallFileOpsMs),
      metadataOpsMs: roundStats(r.summary.metadataOpsMs),
      writeMbps: roundStats(r.summary.writeMbps),
      readMbps: roundStats(r.summary.readMbps),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results[0]?.iterations.length || 0,
      timeoutMs: 120000,
      fileSizeBytes: results[0]?.fileSizeBytes || 0,
      smallFilesCount: results[0]?.smallFilesCount || 0,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
