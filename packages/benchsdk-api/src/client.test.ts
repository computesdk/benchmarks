import { describe, expect, it, vi } from 'vitest';
import { createBenchmarkClient } from './client';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('retry-safe benchmark requests', () => {
  it('retries planWorkers after a fetch failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ workers: [] }));
    const client = createBenchmarkClient({
      apiKey: 'key',
      fetch: fetchMock as typeof fetch,
      retryDelaysMs: [0],
    });

    await expect(client.planWorkers('scale', 'run-1', 'daytona')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries keyed createRun requests', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ run: { id: 'run-1' }, participants: [] }));
    const client = createBenchmarkClient({
      apiKey: 'key',
      fetch: fetchMock as typeof fetch,
      retryDelaysMs: [0],
    });

    await expect(client.createRun('scale', { runKey: 'ci-123' })).resolves.toMatchObject({
      run: { id: 'run-1' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry unkeyed createRun requests', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = createBenchmarkClient({
      apiKey: 'key',
      fetch: fetchMock as typeof fetch,
      retryDelaysMs: [0],
    });

    await expect(client.createRun('scale', {})).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry worker claims', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = createBenchmarkClient({
      apiKey: 'key',
      fetch: fetchMock as typeof fetch,
      retryDelaysMs: [0],
    });

    await expect(client.claimWorker('scale', 'run-1', 'daytona')).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
