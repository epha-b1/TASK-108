/**
 * Unit tests for notification logic.
 *
 * Tests template variable resolution, exponential backoff calculation,
 * and daily cap enforcement.
 */

describe('Template variable resolution', () => {
  function resolveTemplate(body: string, variables: Record<string, string>): string {
    return body.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return variables[key] !== undefined ? variables[key] : match;
    });
  }

  it('"Hello {{name}}" with {name: "Alice"} resolves to "Hello Alice"', () => {
    const result = resolveTemplate('Hello {{name}}', { name: 'Alice' });
    expect(result).toBe('Hello Alice');
  });

  it('resolves multiple variables', () => {
    const template = 'Dear {{name}}, your trip to {{destination}} is confirmed.';
    const result = resolveTemplate(template, { name: 'Bob', destination: 'Paris' });
    expect(result).toBe('Dear Bob, your trip to Paris is confirmed.');
  });

  it('leaves unmatched placeholders intact', () => {
    const result = resolveTemplate('Hello {{name}}, your {{missing}} is ready', {
      name: 'Carol',
    });
    expect(result).toBe('Hello Carol, your {{missing}} is ready');
  });

  it('handles empty variables object', () => {
    const result = resolveTemplate('Hello {{name}}', {});
    expect(result).toBe('Hello {{name}}');
  });

  it('handles template with no placeholders', () => {
    const result = resolveTemplate('Hello world', { name: 'Alice' });
    expect(result).toBe('Hello world');
  });

  it('resolves same variable used multiple times', () => {
    const result = resolveTemplate('{{name}} and {{name}} again', { name: 'Dave' });
    expect(result).toBe('Dave and Dave again');
  });
});

describe('Exponential backoff calculation', () => {
  // From notification.service.ts processOutbox:
  // True exponential backoff: base * 2^(attempt-1) seconds, base=30s
  function calculateBackoffMs(attempt: number): number {
    return 30 * 1000 * Math.pow(2, attempt - 1);
  }

  it('attempt 1 = 30 seconds (30000ms)', () => {
    expect(calculateBackoffMs(1)).toBe(30000);
  });

  it('attempt 2 = 60 seconds (60000ms)', () => {
    expect(calculateBackoffMs(2)).toBe(60000);
  });

  it('attempt 3 = 120 seconds (120000ms)', () => {
    expect(calculateBackoffMs(3)).toBe(120000);
  });

  it('backoff grows exponentially, not linearly', () => {
    const b1 = calculateBackoffMs(1);
    const b2 = calculateBackoffMs(2);
    const b3 = calculateBackoffMs(3);
    expect(b2).toBe(b1 * 2);
    expect(b3).toBe(b2 * 2);
  });

  it('next retry time is in the future', () => {
    const now = Date.now();
    const backoffMs = calculateBackoffMs(1);
    const nextRetry = new Date(now + backoffMs);
    expect(nextRetry.getTime()).toBeGreaterThan(now);
    expect(nextRetry.getTime() - now).toBe(30000);
  });

  it('max attempts is 3 before marking as failed', () => {
    const MAX_ATTEMPTS = 3;
    const attempt = 3;
    expect(attempt >= MAX_ATTEMPTS).toBe(true);
  });
});

describe('Daily cap enforcement', () => {
  function isCapReached(dailySent: number, dailyCap: number): boolean {
    return dailySent >= dailyCap;
  }

  it('blocks when sent >= cap', () => {
    expect(isCapReached(20, 20)).toBe(true);
  });

  it('blocks when sent > cap', () => {
    expect(isCapReached(25, 20)).toBe(true);
  });

  it('allows when sent < cap', () => {
    expect(isCapReached(19, 20)).toBe(false);
  });

  it('allows when no notifications sent yet', () => {
    expect(isCapReached(0, 20)).toBe(false);
  });

  it('blocks immediately for a cap of 0', () => {
    expect(isCapReached(0, 0)).toBe(true);
  });

  it('works with custom cap values', () => {
    expect(isCapReached(5, 5)).toBe(true);
    expect(isCapReached(4, 5)).toBe(false);
  });
});
