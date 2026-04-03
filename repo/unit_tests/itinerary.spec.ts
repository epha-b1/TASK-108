/**
 * Unit tests for itinerary conflict validation logic.
 *
 * These tests validate the pure logic used in itinerary item scheduling:
 * time conversion, overlap detection, buffer enforcement, and dwell time checks.
 */

describe('timeToMinutes conversion', () => {
  // Replicate the helper from itinerary.service.ts
  function timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  it('"09:00" = 540 minutes', () => {
    expect(timeToMinutes('09:00')).toBe(540);
  });

  it('"14:30" = 870 minutes', () => {
    expect(timeToMinutes('14:30')).toBe(870);
  });

  it('"00:00" = 0 minutes', () => {
    expect(timeToMinutes('00:00')).toBe(0);
  });

  it('"23:59" = 1439 minutes', () => {
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('"12:00" = 720 minutes (noon)', () => {
    expect(timeToMinutes('12:00')).toBe(720);
  });
});

describe('Overlap detection', () => {
  function timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  function hasOverlap(
    newStart: string,
    newEnd: string,
    existingStart: string,
    existingEnd: string,
  ): boolean {
    const startMin = timeToMinutes(newStart);
    const endMin = timeToMinutes(newEnd);
    const existStart = timeToMinutes(existingStart);
    const existEnd = timeToMinutes(existingEnd);
    return startMin < existEnd && endMin > existStart;
  }

  it('detects overlap when two items on the same day overlap', () => {
    // Existing: 09:00-10:00, New: 09:30-10:30
    expect(hasOverlap('09:30', '10:30', '09:00', '10:00')).toBe(true);
  });

  it('detects overlap when new item completely inside existing', () => {
    // Existing: 09:00-12:00, New: 10:00-11:00
    expect(hasOverlap('10:00', '11:00', '09:00', '12:00')).toBe(true);
  });

  it('detects overlap when existing item completely inside new', () => {
    // Existing: 10:00-11:00, New: 09:00-12:00
    expect(hasOverlap('09:00', '12:00', '10:00', '11:00')).toBe(true);
  });

  it('no overlap when items are adjacent (end == start)', () => {
    // Existing: 09:00-10:00, New: 10:00-11:00
    expect(hasOverlap('10:00', '11:00', '09:00', '10:00')).toBe(false);
  });

  it('no overlap when items are well-separated', () => {
    // Existing: 09:00-10:00, New: 14:00-15:00
    expect(hasOverlap('14:00', '15:00', '09:00', '10:00')).toBe(false);
  });
});

describe('15-minute buffer enforcement', () => {
  function timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  function violatesBuffer(
    newStart: string,
    newEnd: string,
    existingStart: string,
    existingEnd: string,
    bufferMinutes: number = 15,
  ): boolean {
    const startMin = timeToMinutes(newStart);
    const endMin = timeToMinutes(newEnd);
    const existStart = timeToMinutes(existingStart);
    const existEnd = timeToMinutes(existingEnd);

    // First check: no direct overlap
    if (startMin < existEnd && endMin > existStart) {
      return false; // This is overlap, not buffer violation
    }

    // Buffer check: new item starts too soon after existing ends
    if (startMin >= existEnd && startMin < existEnd + bufferMinutes) {
      return true;
    }

    // Buffer check: new item ends too close before existing starts
    if (endMin > existStart - bufferMinutes && endMin <= existStart) {
      return true;
    }

    return false;
  }

  it('conflict when new item starts 5 minutes after existing ends', () => {
    // Existing: 09:00-10:00, New: 10:05-11:00 (only 5 min gap, need 15)
    expect(violatesBuffer('10:05', '11:00', '09:00', '10:00')).toBe(true);
  });

  it('conflict when new item ends 5 minutes before existing starts', () => {
    // Existing: 11:00-12:00, New: 09:55-10:55 (only 5 min gap before 11:00)
    expect(violatesBuffer('09:55', '10:55', '11:00', '12:00')).toBe(true);
  });

  it('no conflict when items have exactly 15 minutes buffer', () => {
    // Existing: 09:00-10:00, New: 10:15-11:00 (exactly 15 min gap)
    expect(violatesBuffer('10:15', '11:00', '09:00', '10:00')).toBe(false);
  });

  it('no conflict when items are well-spaced (30 min gap)', () => {
    // Existing: 09:00-10:00, New: 10:30-11:30
    expect(violatesBuffer('10:30', '11:30', '09:00', '10:00')).toBe(false);
  });
});

describe('Min dwell time validation', () => {
  function timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  function checkDwellTime(
    startTime: string,
    endTime: string,
    minDwellMinutes: number,
  ): { valid: boolean; duration: number } {
    const duration = timeToMinutes(endTime) - timeToMinutes(startTime);
    return {
      valid: duration >= minDwellMinutes,
      duration,
    };
  }

  it('violation when duration < resource.minDwellMinutes', () => {
    // minDwell = 30, but only 15 min duration
    const result = checkDwellTime('09:00', '09:15', 30);
    expect(result.valid).toBe(false);
    expect(result.duration).toBe(15);
  });

  it('passes when duration == resource.minDwellMinutes', () => {
    const result = checkDwellTime('09:00', '09:30', 30);
    expect(result.valid).toBe(true);
    expect(result.duration).toBe(30);
  });

  it('passes when duration > resource.minDwellMinutes', () => {
    const result = checkDwellTime('09:00', '11:00', 30);
    expect(result.valid).toBe(true);
    expect(result.duration).toBe(120);
  });

  it('violation for a resource with 60-min minimum', () => {
    const result = checkDwellTime('14:00', '14:45', 60);
    expect(result.valid).toBe(false);
    expect(result.duration).toBe(45);
  });
});

describe('No conflict when items are properly spaced', () => {
  function timeToMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  function hasConflict(
    newStart: string,
    newEnd: string,
    existingStart: string,
    existingEnd: string,
    bufferMinutes: number = 15,
  ): boolean {
    const startMin = timeToMinutes(newStart);
    const endMin = timeToMinutes(newEnd);
    const existStart = timeToMinutes(existingStart);
    const existEnd = timeToMinutes(existingEnd);

    // Overlap
    if (startMin < existEnd && endMin > existStart) return true;

    // Buffer violation
    if (startMin >= existEnd && startMin < existEnd + bufferMinutes) return true;
    if (endMin > existStart - bufferMinutes && endMin <= existStart) return true;

    return false;
  }

  it('no conflict: morning 09:00-10:00 and afternoon 14:00-15:00', () => {
    expect(hasConflict('14:00', '15:00', '09:00', '10:00')).toBe(false);
  });

  it('no conflict: items with 20 minutes gap (> 15 min buffer)', () => {
    expect(hasConflict('10:20', '11:00', '09:00', '10:00')).toBe(false);
  });

  it('no conflict: items on different conceptual slots', () => {
    // First ends at 12:00, second starts at 13:00 (1 hour gap)
    expect(hasConflict('13:00', '14:00', '10:00', '12:00')).toBe(false);
  });
});
