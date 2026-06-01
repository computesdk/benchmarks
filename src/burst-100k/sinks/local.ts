import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SandboxResult, ProgressStats, FinalStats } from '../types.js';

export class LocalSink {
  private outputDir: string;
  private rawStream: fs.WriteStream;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.rawStream = fs.createWriteStream(path.join(this.outputDir, 'raw.jsonl'), { flags: 'a' });
  }

  writeResult(result: SandboxResult): void {
    this.rawStream.write(JSON.stringify(result) + '\n');
  }

  async writeHeartbeat(stats: ProgressStats & { ts: string }): Promise<void> {
    await fs.promises.writeFile(
      path.join(this.outputDir, 'heartbeat.json'),
      JSON.stringify(stats, null, 2),
    );
  }

  async writeMeta(meta: FinalStats & Record<string, unknown>): Promise<void> {
    await fs.promises.writeFile(
      path.join(this.outputDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
    );
  }

  async writeLog(content: string): Promise<void> {
    await fs.promises.writeFile(path.join(this.outputDir, 'coordinator.log'), content);
  }

  async writeMetrics(samples: ReadonlyArray<unknown>): Promise<void> {
    const body = samples.map(s => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : '');
    await fs.promises.writeFile(path.join(this.outputDir, 'metrics.jsonl'), body);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.rawStream.end((err?: Error | null) => err ? reject(err) : resolve());
    });
  }
}
