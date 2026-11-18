import { TaskError } from "@benchsdk/runner";
import type { JsonObject } from "@benchsdk/client";
import { percentile } from "../src/util/stats.js";

export interface TtiSummary {
  readyCount: number;
  ttiMinMs?: number;
  ttiMedianMs?: number;
  ttiP95Ms?: number;
  ttiP99Ms?: number;
  ttiMaxMs?: number;
}

/**
 * TTI percentiles over the boxes that became ready. With no ready box every
 * timing is omitted rather than recorded as 0ms — a lower-is-better 0 would
 * score as a perfect TTI for a burst that never came up.
 */
export function summarizeTti(
  ttiMs: ReadonlyArray<number | undefined>,
): TtiSummary {
  const measured = ttiMs
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  if (measured.length === 0) return { readyCount: 0 };
  const mid = Math.floor(measured.length / 2);
  return {
    readyCount: measured.length,
    ttiMinMs: measured[0],
    ttiMedianMs:
      measured.length % 2 === 0
        ? (measured[mid - 1] + measured[mid]) / 2
        : measured[mid],
    ttiP95Ms: percentile(measured, 95),
    ttiP99Ms: percentile(measured, 99),
    ttiMaxMs: measured[measured.length - 1],
  };
}

/**
 * A burst with zero surviving boxes is a failed iteration, not a slow one:
 * partial survival is scored proportionally by alivePct, total loss fails so
 * the record cannot pick up speed points from timings of boxes that died.
 */
export function noSurvivorsError(
  aliveCount: number,
  burstCount: number,
  data: JsonObject,
): TaskError | undefined {
  if (aliveCount > 0) return undefined;
  return new TaskError(
    `no sandbox survived the burst (0/${burstCount} alive)`,
    {
      code: "no_survivors",
      data,
    },
  );
}
