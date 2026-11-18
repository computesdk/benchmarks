import assert from "node:assert/strict";
import { noSurvivorsError, summarizeTti } from "./burst-summary.js";

// Every box failed before readiness: no timing may be reported as 0ms.
const none = summarizeTti([undefined, undefined, undefined]);
assert.deepEqual(none, { readyCount: 0 });
for (const key of [
  "ttiMinMs",
  "ttiMedianMs",
  "ttiP95Ms",
  "ttiP99Ms",
  "ttiMaxMs",
] as const) {
  assert.equal(
    none[key],
    undefined,
    `${key} must be omitted with no ready box`,
  );
}

const some = summarizeTti([300, undefined, 100, 200, 400]);
assert.equal(some.readyCount, 4);
assert.equal(some.ttiMinMs, 100);
assert.equal(some.ttiMedianMs, 250);
assert.equal(some.ttiMaxMs, 400);
assert.equal(some.ttiP99Ms, 400);

// alivePct 0 fails the iteration; any survivor keeps it a scored success.
const err = noSurvivorsError(0, 50, { alivePct: 0 });
assert.ok(err, "zero survivors must fail");
assert.equal(err.code, "no_survivors");
assert.match(err.message, /0\/50 alive/);
assert.equal(noSurvivorsError(1, 50, { alivePct: 2 }), undefined);

console.log("burst-summary tests passed");
