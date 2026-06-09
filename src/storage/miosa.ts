import type {
  DownloadResult,
  ListOptions,
  ListResult,
  StorageObject,
  StorageProvider,
  UploadOptions,
} from '@computesdk/provider';

interface MiosaConfig {
  apiKey?: string;
  baseUrl?: string;
}

interface MiosaObject {
  key?: string;
  size?: number;
  size_bytes?: number;
  content_type?: string;
  etag?: string;
  last_modified?: string;
}

interface MiosaListResponse {
  data?: MiosaObject[];
  objects?: MiosaObject[];
  items?: MiosaObject[];
  cursor?: string;
  next_cursor?: string;
  nextContinuationToken?: string;
  truncated?: boolean;
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function objectPath(bucket: string, key: string): string {
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `/storage/buckets/${encodeURIComponent(bucket)}/objects/${encodedKey}`;
}

function toBody(data: Uint8Array | string): BodyInit {
  if (typeof data === 'string') return data;
  return new Blob([data.slice()]);
}

function byteLength(data: Uint8Array | string): number {
  return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
}

function toStorageObject(bucket: string, object: MiosaObject): StorageObject {
  return {
    bucket,
    key: object.key || '',
    size: object.size_bytes ?? object.size ?? 0,
    etag: object.etag,
    lastModified: object.last_modified ? new Date(object.last_modified) : undefined,
  };
}

async function parseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return `${response.status} ${response.statusText}`;

  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; code?: string };
      message?: string;
    };
    return body.error?.message || body.error?.code || body.message || text;
  } catch {
    return text;
  }
}

export function miosa(config: MiosaConfig = {}): StorageProvider {
  const apiKey = config.apiKey || process.env.MIOSA_API_KEY;
  const baseUrl = cleanBaseUrl(
    config.baseUrl || process.env.MIOSA_BASE_URL || 'https://api.miosa.ai/api/v1',
  );

  if (!apiKey) {
    throw new Error("Missing MIOSA API key. Provide 'apiKey' in config or set MIOSA_API_KEY.");
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${apiKey}`);
    headers.set('Accept', 'application/json');

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      throw new Error(await parseError(response));
    }

    return response;
  }

  return {
    async upload(
      bucket: string,
      key: string,
      data: Uint8Array | string,
      options?: UploadOptions,
    ): Promise<StorageObject> {
      const response = await request(objectPath(bucket, key), {
        method: 'PUT',
        headers: {
          'Content-Type': options?.contentType || 'application/octet-stream',
        },
        body: toBody(data),
      });

      return {
        bucket,
        key,
        size: byteLength(data),
        etag: response.headers.get('etag') || undefined,
        lastModified: new Date(),
        metadata: options?.metadata,
      };
    },

    async download(bucket: string, key: string): Promise<DownloadResult> {
      const response = await request(objectPath(bucket, key));
      const arrayBuffer = await response.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);

      return {
        data,
        size: data.byteLength,
        contentType: response.headers.get('content-type') || undefined,
        etag: response.headers.get('etag') || undefined,
        lastModified: response.headers.get('last-modified')
          ? new Date(response.headers.get('last-modified')!)
          : undefined,
      };
    },

    async delete(bucket: string, key: string): Promise<void> {
      await request(objectPath(bucket, key), { method: 'DELETE' });
    },

    async list(bucket: string, options?: ListOptions): Promise<ListResult> {
      const params = new URLSearchParams();
      if (options?.prefix) params.set('prefix', options.prefix);
      if (options?.maxKeys) params.set('max_keys', String(options.maxKeys));
      if (options?.continuationToken) params.set('marker', options.continuationToken);

      const query = params.toString();
      const response = await request(
        `/storage/buckets/${encodeURIComponent(bucket)}/objects${query ? `?${query}` : ''}`,
      );
      const payload = (await response.json()) as MiosaListResponse | MiosaObject[];
      const objects = Array.isArray(payload)
        ? payload
        : payload.data || payload.objects || payload.items || [];
      const continuationToken = Array.isArray(payload)
        ? undefined
        : payload.next_cursor || payload.cursor || payload.nextContinuationToken;

      return {
        objects: objects.map((object) => toStorageObject(bucket, object)),
        truncated: Array.isArray(payload) ? false : Boolean(payload.truncated || continuationToken),
        continuationToken,
      };
    },
  };
}
