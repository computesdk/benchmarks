#!/usr/bin/env node
// Imports from the package entry (not a relative path) so the bin and any
// benchmark module it loads share a single `@benchsdk/runner` instance — this
// keeps `instanceof` checks (TaskError / NoAvailableParticipantsError) valid
// across the bin and the dynamically imported `*.bench.ts`.
import { register } from 'tsx/esm/api';
import { run } from '@benchsdk/runner';

register();
run(process.argv.slice(2));
