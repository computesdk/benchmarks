import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHAIN_FILE,
  SEED_HASH,
  SOAK_LIFETIME_HEADROOM_MS,
  WRITER_SCRIPT,
  WRITER_SCRIPT_BODY,
  launchWriterCmd,
  soakLifetime,
  verifyTail,
  writerAliveCmd,
} from "./sandbox-soak.js";

const SHIFT = 355 * 60_000;

// Unknown cap: the shift is still requested instead of the adapter default.
const unknown = soakLifetime("tenki", SHIFT);
assert.equal(unknown.lifetimeMs, SHIFT + SOAK_LIFETIME_HEADROOM_MS);
assert.equal(unknown.source, "requested");
assert.equal(unknown.maxLifetimeMs, null);
assert.equal(unknown.maxShorterThanShift, false);

assert.equal(soakLifetime("x", SHIFT, { maxMs: 3_600_000 }).source, "sdk");

const sh = (cmd: string) =>
  execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Relaunching an alive writer must not start a second appender.
  const dir = mkdtempSync(path.join(tmpdir(), "soak-"));
  writeFileSync(path.join(dir, WRITER_SCRIPT), WRITER_SCRIPT_BODY);
  try {
    sh(launchWriterCmd(dir));
    await sleep(1_500);
    assert.match(sh(writerAliveCmd(dir)), /writer=alive/);
    sh(launchWriterCmd(dir));
    sh(launchWriterCmd(dir));
    await sleep(3_000);
    const writers = sh(
      `ps -eo args | grep -c '[s]oak-writer.sh ${dir}' || true`,
    ).trim();
    assert.equal(writers, "1", "exactly one writer process");
    const chain = readFileSync(path.join(dir, CHAIN_FILE), "utf8");
    const v = verifyTail(chain, 0, SEED_HASH, 0);
    assert.ok(v.newLines >= 3, `chain grew (${v.newLines})`);
    assert.equal(v.badLines, 0, "no interleaved/corrupt links");
  } finally {
    sh(`kill $(cat ${dir}/${CHAIN_FILE}.lock/pid) 2>/dev/null || true`);
  }
  assert.match(sh(writerAliveCmd(dir)), /writer=dead/);

  // A dead writer's pid reused by another process must not block recovery.
  const decoy = sh("sleep 60 >/dev/null 2>&1 & echo $!").trim();
  try {
    writeFileSync(path.join(dir, `${CHAIN_FILE}.lock`, "pid"), decoy);
    assert.match(
      sh(writerAliveCmd(dir)),
      /writer=dead/,
      "reused pid is not the writer",
    );
    const before = readFileSync(path.join(dir, CHAIN_FILE), "utf8").split(
      "\n",
    ).length;
    sh(launchWriterCmd(dir));
    await sleep(2_500);
    assert.match(sh(writerAliveCmd(dir)), /writer=alive/);
    const after = readFileSync(path.join(dir, CHAIN_FILE), "utf8").split(
      "\n",
    ).length;
    assert.ok(after > before, "relaunched writer took over the stale lock");
  } finally {
    sh(
      `kill ${decoy} $(cat ${dir}/${CHAIN_FILE}.lock/pid) 2>/dev/null || true`,
    );
  }
  console.log("sandbox-soak tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
