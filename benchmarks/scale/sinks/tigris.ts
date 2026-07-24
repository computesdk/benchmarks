import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough } from 'node:stream';
import type { SandboxResult, ProgressStats, FinalStats } from '../types.js';

export interface TigrisConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class TigrisSink {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private rawStream: PassThrough;
  private rawUploadDone: Promise<unknown>;

  constructor(config: TigrisConfig, runId: string) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: 'auto',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.bucket = config.bucket;
    this.prefix = `${runId}/`;

    // Multipart streaming upload of raw.jsonl. S3-compatible multipart
    // minimum part size is 5 MiB; lib-storage's Upload buffers internally
    // until that threshold and then uploads parts. Crash-loss window: at
    // most one part worth of records.
    this.rawStream = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: `${this.prefix}raw.jsonl`,
        Body: this.rawStream,
        ContentType: 'application/x-ndjson',
      },
      partSize: 5 * 1024 * 1024,
      queueSize: 4,
    });
    this.rawUploadDone = upload.done();
    this.rawUploadDone.catch(() => { /* awaited in close() */ });
  }

  writeResult(result: SandboxResult): void {
    this.rawStream.write(JSON.stringify(result) + '\n');
  }

  async writeHeartbeat(stats: ProgressStats & { ts: string }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.prefix}heartbeat.json`,
      Body: JSON.stringify(stats),
      ContentType: 'application/json',
    }));
  }

  async writeMeta(meta: FinalStats & Record<string, unknown>): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.prefix}meta.json`,
      Body: JSON.stringify(meta, null, 2),
      ContentType: 'application/json',
    }));
  }

  async writeLog(content: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.prefix}coordinator.log`,
      Body: content,
      ContentType: 'text/plain; charset=utf-8',
    }));
  }

  /**
   * Overwrite metrics.jsonl with the full sample array on every heartbeat
   * plus shutdown. Low-volume (~one short JSON object every 5s), so re-PUTing
   * the whole file each heartbeat is cheap and gives partial-result durability
   * without multipart-stream complexity.
   */
  async writeMetrics(samples: ReadonlyArray<unknown>): Promise<void> {
    const body = samples.map(s => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : '');
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.prefix}metrics.jsonl`,
      Body: body,
      ContentType: 'application/x-ndjson',
    }));
  }

  async close(): Promise<void> {
    this.rawStream.end();
    await this.rawUploadDone;
  }
}
