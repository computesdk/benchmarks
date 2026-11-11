import { createInterface } from 'node:readline/promises';

/**
 * Confirmation gate for writes that hide or discard data. `-y`/`--yes`
 * skips it; on a terminal bench asks; anywhere else (CI, a pipe, an agent)
 * it refuses before any request is sent, so an unattended caller has to opt
 * in explicitly.
 *
 * `action` is lower-case and reads after "Refusing to …", e.g.
 * `archive benchmark alpha and all of its runs`.
 */
export async function confirmWrite(options: { yes: boolean; action: string }): Promise<void> {
  if (options.yes) return;
  if (!process.stdin.isTTY) {
    throw new Error(
      `Refusing to ${options.action} without confirmation: stdin is not a terminal. Pass -y (or --yes) to confirm.`,
    );
  }
  const question = `${options.action.charAt(0).toUpperCase()}${options.action.slice(1)}? [y/N] `;
  // The prompt goes to stderr so `--json` output on stdout stays parseable.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let answer: string;
  try {
    answer = await rl.question(question);
  } finally {
    rl.close();
  }
  if (!/^(y|yes)$/i.test(answer.trim())) {
    throw new Error('Aborted; nothing was changed.');
  }
}
