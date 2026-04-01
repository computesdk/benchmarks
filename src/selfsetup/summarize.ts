#!/usr/bin/env tsx
/**
 * Generate markdown summary of self-setup results
 * 
 * Usage: tsx src/selfsetup/summarize.ts <results-dir>
 */

import fs from 'fs';
import path from 'path';
import type { SelfSetupResult } from './types.js';

const resultsDir = process.argv[2];

if (!resultsDir) {
  console.error('Usage: tsx src/selfsetup/summarize.ts <results-dir>');
  process.exit(1);
}

const summaryPath = path.join(resultsDir, 'summary.json');

if (!fs.existsSync(summaryPath)) {
  console.error(`Summary not found: ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

// Generate table rows
const rows = summary.results.map((r: SelfSetupResult, i: number) => {
  const timeMin = (r.totalTimeMs / 60000).toFixed(1);
  const autonomy = r.humanInterventions === 0 ? '✓' : '✗';
  const quality = r.codeQuality === 'excellent' ? 'A' : r.codeQuality === 'good' ? 'B' : 'C';
  const docs = r.docComplaints === 0 ? '✓' : r.docComplaints <= 2 ? '~' : '✗';
  
  return `| ${i + 1} | ${r.provider} | **${r.score.total}** | ${r.passed ? '✅' : '❌'} | ${timeMin}m | ${autonomy} | ${quality} | ${docs} |`;
});

console.log(`
## Self-Setup Benchmark Results

*Last updated: ${summary.timestamp}*

### Leaderboard

| Rank | Provider | Score | Pass | Time | Autonomy | Quality | Docs |
|------|----------|-------|------|------|----------|---------|------|
${rows.join('\n')}

### Summary

- **Total tested:** ${summary.summary.total}
- **Passed (≥90):** ${summary.summary.passed}
- **Failed:** ${summary.summary.failed}

### Scoring Methodology

| Category | Weight | Description |
|----------|--------|-------------|
| Autonomy | 40% | Zero human intervention required |
| Time | 20% | ≤5min=100, ≤10min=70, ≤15min=40 |
| Code Quality | 20% | Clean, idiomatic, handles errors |
| Error Recovery | 10% | Graceful handling of failures |
| Documentation | 10% | Clear, no AI complaints |

**Pass threshold: ≥90/100**

---

*Run weekly via OpenCode AI agent in GitHub Actions*
`);
