/**
 * Unit tests for notification template/backoff/cap logic.
 *
 * The previous version of this file replicated `resolveTemplate`,
 * `calculateBackoffMs`, and the cap rule locally and tested the
 * replicas. That gave a false sense of coverage — production drift
 * could not be detected. This rewrite imports the REAL exports from
 * `src/services/notification.service.ts` so the assertions track
 * production behaviour directly. Audit issue 6.
 *
 * Coverage:
 *   - resolveTemplate: variable substitution, missing-key behaviour,
 *     repeated-key resolution, no-placeholder identity.
 *   - calculateBackoffMs: exponential schedule for attempts 1..3 plus
 *     cross-attempt growth assertion.
 *   - isDailyCapReached: boundary semantics including cap-of-zero.
 *   - MAX_OUTBOX_ATTEMPTS: lock the production constant.
 */

import {
  resolveTemplate,
  calculateBackoffMs,
  isDailyCapReached,
  MAX_OUTBOX_ATTEMPTS,
} from '../src/services/notification.service';

describe('resolveTemplate (real production export)', () => {
  it('"Hello {{name}}" with {name: "Alice"} resolves to "Hello Alice"', () => {
    expect(resolveTemplate('Hello {{name}}', { name: 'Alice' })).toBe('Hello Alice');
  });

  it('resolves multiple distinct variables', () => {
    expect(
      resolveTemplate('Dear {{name}}, your trip to {{destination}} is confirmed.', {
        name: 'Bob',
        destination: 'Paris',
      }),
    ).toBe('Dear Bob, your trip to Paris is confirmed.');
  });

  it('leaves unmatched placeholders intact (so a missing variable is visible to the operator)', () => {
    expect(
      resolveTemplate('Hello {{name}}, your {{missing}} is ready', { name: 'Carol' }),
    ).toBe('Hello Carol, your {{missing}} is ready');
  });

  it('handles empty variables object', () => {
    expect(resolveTemplate('Hello {{name}}', {})).toBe('Hello {{name}}');
  });

  it('returns the body unchanged when there are no placeholders', () => {
    expect(resolveTemplate('Hello world', { name: 'Alice' })).toBe('Hello world');
  });

  it('resolves the same variable used multiple times', () => {
    expect(resolveTemplate('{{name}} and {{name}} again', { name: 'Dave' })).toBe(
      'Dave and Dave again',
    );
  });
});

describe('calculateBackoffMs (real production export)', () => {
  it('attempt 1 = 30s', () => {
    expect(calculateBackoffMs(1)).toBe(30_000);
  });

  it('attempt 2 = 60s', () => {
    expect(calculateBackoffMs(2)).toBe(60_000);
  });

  it('attempt 3 = 120s', () => {
    expect(calculateBackoffMs(3)).toBe(120_000);
  });

  it('grows exponentially (doubling each step)', () => {
    expect(calculateBackoffMs(2)).toBe(calculateBackoffMs(1) * 2);
    expect(calculateBackoffMs(3)).toBe(calculateBackoffMs(2) * 2);
  });

  it('next retry time is in the future relative to "now"', () => {
    const now = Date.now();
    const nextRetry = new Date(now + calculateBackoffMs(1));
    expect(nextRetry.getTime()).toBeGreaterThan(now);
  });
});

describe('MAX_OUTBOX_ATTEMPTS (real production constant)', () => {
  it('ceiling is exactly 3 — outbox stops retrying after that', () => {
    expect(MAX_OUTBOX_ATTEMPTS).toBe(3);
  });
});

describe('isDailyCapReached (real production export)', () => {
  it('blocks when sent equals cap (inclusive)', () => {
    expect(isDailyCapReached(20, 20)).toBe(true);
  });

  it('blocks when sent exceeds cap', () => {
    expect(isDailyCapReached(25, 20)).toBe(true);
  });

  it('allows when sent < cap', () => {
    expect(isDailyCapReached(19, 20)).toBe(false);
  });

  it('allows on a brand-new day with no sends yet', () => {
    expect(isDailyCapReached(0, 20)).toBe(false);
  });

  it('blocks immediately for a cap of 0', () => {
    expect(isDailyCapReached(0, 0)).toBe(true);
  });

  it('works with custom cap values', () => {
    expect(isDailyCapReached(5, 5)).toBe(true);
    expect(isDailyCapReached(4, 5)).toBe(false);
  });
});
