/**
 * Structured stdout logger — GitHub Actions-style phase markers, timestamped
 * level-tagged lines, no colors (so the file uploaded to Tigris stays clean).
 *
 *   2026-05-14T18:54:25.123Z [info ]  ━━━ scale coordinator starting ━━━
 *   2026-05-14T18:54:25.456Z [info ]  run_id=… provider=e2b
 *   2026-05-14T18:54:26.001Z [ok   ]  sandbox 0 created in 134ms — sandboxId=…
 *   2026-05-14T18:54:31.500Z [stat ]  progress 10/100 (in_flight=0 errors=0) eta ≈54s
 *   2026-05-14T18:55:25.890Z [error]  sandbox 12 network_error: connect ECONNREFUSED
 *   2026-05-14T18:55:25.890Z [info ]  ━━━ run complete ━━━
 */

type Level = 'info' | 'ok' | 'warn' | 'error' | 'stat' | 'data' | 'debug';

// In-memory mirror of every emitted line, uploaded to Tigris as coordinator.log
// at shutdown. The container runs `node coordinator.cjs` directly (no wrapper
// tee'ing stdout to a file), so the process must capture its own output. Lines
// are already color-free, so the buffer is upload-clean as-is.
const buffer: string[] = [];

function write(level: Level, msg: string): void {
  const ts = new Date().toISOString();
  const tag = `[${level}]`.padEnd(7);
  const line = `${ts} ${tag} ${msg}\n`;
  buffer.push(line);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line);
}

export const log = {
  info(msg: string): void { write('info', msg); },
  ok(msg: string): void { write('ok', msg); },
  warn(msg: string): void { write('warn', msg); },
  error(msg: string): void { write('error', msg); },
  stat(msg: string): void { write('stat', msg); },
  /**
   * Emit a structured-data line, JSON-serialized on a single line. Intended
   * to follow a human-readable [ok]/[error] line so a per-sandbox record is
   * visually nested under its summary. Whatever shape is passed flows through
   * verbatim — adding fields to the source object is enough to expose them.
   */
  data(obj: unknown): void {
    write('data', typeof obj === 'string' ? obj : JSON.stringify(obj));
  },
  debug(msg: string): void {
    if (process.env.BURST_100K_DEBUG === '1') write('debug', msg);
  },
  phase(title: string): void { write('info', `━━━ ${title} ━━━`); },
  /** Full transcript emitted so far, for uploading as coordinator.log. */
  dump(): string { return buffer.join(''); },
};
