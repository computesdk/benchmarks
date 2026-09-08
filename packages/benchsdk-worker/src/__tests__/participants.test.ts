import { describe, expect, it } from 'vitest';
import { filterParticipantsByEnv, selectParticipants } from '../participants';

describe('filterParticipantsByEnv', () => {
  it('treats a missing requiredEnvVars as an empty list', () => {
    const participants = [{ name: 'local' }];
    const { available, skipped } = filterParticipantsByEnv(participants);
    expect(available).toEqual(participants);
    expect(skipped).toEqual([]);
  });

  it('treats a non-array requiredEnvVars as an empty list', () => {
    const participants = [{ name: 'local', requiredEnvVars: 'x' as unknown as string[] }];
    const { available, skipped } = filterParticipantsByEnv(participants);
    expect(available).toEqual(participants);
    expect(skipped).toEqual([]);
  });

  it('returns available participants whose env vars are set', () => {
    process.env.BENCHSDK_TEST_VAR = '1';
    const participants = [
      { name: 'ready', requiredEnvVars: ['BENCHSDK_TEST_VAR'] },
      { name: 'missing', requiredEnvVars: ['BENCHSDK_TEST_VAR', 'BENCHSDK_MISSING_VAR'] },
    ];
    const { available, skipped } = filterParticipantsByEnv(participants);
    expect(available).toEqual([participants[0]]);
    expect(skipped).toEqual([{ name: 'missing', missing: ['BENCHSDK_MISSING_VAR'] }]);
    delete process.env.BENCHSDK_TEST_VAR;
  });
});

describe('selectParticipants', () => {
  it('returns all participants when no names are given', () => {
    const participants = [{ name: 'a' }, { name: 'b' }];
    expect(selectParticipants(participants)).toEqual(participants);
  });

  it('filters to requested names', () => {
    const participants = [{ name: 'a' }, { name: 'b' }];
    expect(selectParticipants(participants, ['b'])).toEqual([participants[1]]);
  });

  it('throws with the available set for unknown names', () => {
    const participants = [{ name: 'a' }, { name: 'b' }];
    expect(() => selectParticipants(participants, ['c'])).toThrow('a, b');
  });
});
