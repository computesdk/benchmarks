import type { SelfSetupResult, SelfSetupStep } from './types.js';

/**
 * Self-Setup Benchmark Scorer
 * 
 * Implements the 0-100 scoring from the AI Self-Setup Benchmark v1.0:
 * 
 * Category            Weight
 * Fully autonomous    40% (zero human intervention)
 * Time                20% (≤5min=100, ≤10min=70, ≤15min=40)
 * Quality of integration  20% (clean, idiomatic code)
 * Error recovery      10% (handles errors gracefully)
 * Documentation clarity  10% (AI never complained)
 * 
 * Pass threshold: ≥ 90/100
 */

const WEIGHTS = {
  autonomy: 0.40,
  time: 0.20,
  quality: 0.20,
  recovery: 0.10,
  docs: 0.10,
} as const;

const TIME_THRESHOLDS = {
  excellent: 5 * 60 * 1000,   // 5 min = 100% of time score
  good: 10 * 60 * 1000,       // 10 min = 70% of time score
  acceptable: 15 * 60 * 1000, // 15 min = 40% of time score
} as const;

const QUALITY_SCORES = {
  excellent: 1.0,
  good: 0.75,
  messy: 0.50,
  failed: 0.0,
} as const;

const PASS_THRESHOLD = 90;

/**
 * Calculate the autonomy score (40% weight)
 * 
 * 40 points if zero human interventions
 * 0 points if any human intervention occurred
 */
function calculateAutonomyScore(humanInterventions: number): number {
  // Binary: fully autonomous or not
  return humanInterventions === 0 ? 100 : 0;
}

/**
 * Calculate the time score (20% weight)
 * 
 * ≤ 5 min = 100 points
 * ≤ 10 min = 70 points  
 * ≤ 15 min = 40 points
 * > 15 min = 0 points
 */
function calculateTimeScore(totalTimeMs: number): number {
  if (totalTimeMs <= TIME_THRESHOLDS.excellent) {
    return 100;
  }
  if (totalTimeMs <= TIME_THRESHOLDS.good) {
    return 70;
  }
  if (totalTimeMs <= TIME_THRESHOLDS.acceptable) {
    return 40;
  }
  return 0;
}

/**
 * Calculate the code quality score (20% weight)
 */
function calculateQualityScore(codeQuality: SelfSetupResult['codeQuality']): number {
  return QUALITY_SCORES[codeQuality] * 100;
}

/**
 * Calculate the error recovery score (10% weight)
 * 
 * Score based on percentage of errors that were handled gracefully
 */
function calculateRecoveryScore(errors: SelfSetupResult['errors']): number {
  if (errors.length === 0) {
    return 100; // No errors = perfect recovery
  }
  
  const handledErrors = errors.filter(e => e.handled).length;
  return (handledErrors / errors.length) * 100;
}

/**
 * Calculate the docs clarity score (10% weight)
 * 
 * 10 points if zero complaints
 * 5 points if 1-2 complaints
 * 0 points if 3+ complaints
 */
function calculateDocsScore(docComplaints: number): number {
  if (docComplaints === 0) {
    return 100;
  }
  if (docComplaints <= 2) {
    return 50;
  }
  return 0;
}

/**
 * Compute the full composite score for a self-setup result
 */
export function computeScore(result: Omit<SelfSetupResult, 'score' | 'passed'>): SelfSetupResult['score'] {
  const autonomyRaw = calculateAutonomyScore(result.humanInterventions);
  const timeRaw = calculateTimeScore(result.totalTimeMs);
  const qualityRaw = calculateQualityScore(result.codeQuality);
  const recoveryRaw = calculateRecoveryScore(result.errors);
  const docsRaw = calculateDocsScore(result.docComplaints);

  // Apply weights
  const autonomy = Math.round(autonomyRaw * WEIGHTS.autonomy);
  const time = Math.round(timeRaw * WEIGHTS.time);
  const quality = Math.round(qualityRaw * WEIGHTS.quality);
  const recovery = Math.round(recoveryRaw * WEIGHTS.recovery);
  const docs = Math.round(docsRaw * WEIGHTS.docs);

  const total = autonomy + time + quality + recovery + docs;

  return {
    total,
    autonomy,
    time,
    quality,
    recovery,
    docs,
  };
}

/**
 * Determine if the result passes (≥ 90)
 */
export function didPass(score: number): boolean {
  return score >= PASS_THRESHOLD;
}

/**
 * Score breakdown explanation
 */
export function explainScore(score: SelfSetupResult['score']): string {
  const lines = [
    `Self-Setup Score: ${score.total}/100 ${didPass(score.total) ? '✓ PASS' : '✗ FAIL'}`,
    '',
    'Breakdown:',
    `  Autonomy (40%):      ${score.autonomy}/40  ${score.autonomy === 40 ? '✓' : '✗'}`,
    `  Time (20%):          ${score.time}/20  ${score.time >= 8 ? '✓' : '✗'}`,
    `  Code Quality (20%):  ${score.quality}/20  ${score.quality >= 10 ? '✓' : '✗'}`,
    `  Error Recovery (10%): ${score.recovery}/10`,
    `  Docs Clarity (10%):  ${score.docs}/10`,
    '',
    didPass(score.total) 
      ? 'This provider has excellent AI-first developer experience.'
      : 'This provider needs improvement for AI self-setup.',
  ];
  
  return lines.join('\n');
}

/**
 * Get grade letter from score
 */
export function getGrade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 60) return 'C';
  return 'F';
}
