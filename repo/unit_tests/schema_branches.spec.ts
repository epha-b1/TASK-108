/**
 * Coverage for the stray uncovered lines in `src/schemas/itinerary.schemas.ts`
 * (the empty-object refine) and `src/schemas/resource.schemas.ts` (the
 * same refine + strict mode rejection path).
 */

import { updateItinerarySchema } from '../src/schemas/itinerary.schemas';
import { updateResourceSchema } from '../src/schemas/resource.schemas';

describe('updateItinerarySchema', () => {
  it('rejects an empty body via the refine', () => {
    const result = updateItinerarySchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toMatch(/At least one field/);
    }
  });

  it('accepts a single-field update', () => {
    const result = updateItinerarySchema.safeParse({ title: 'X' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid status enum value', () => {
    const result = updateItinerarySchema.safeParse({ status: 'deleted' });
    expect(result.success).toBe(false);
  });
});

describe('updateResourceSchema', () => {
  it('rejects empty body', () => {
    const result = updateResourceSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('strict mode rejects unknown keys', () => {
    const result = updateResourceSchema.safeParse({ name: 'X', bogus: 'nope' });
    expect(result.success).toBe(false);
  });

  it('accepts valid partial update with null city', () => {
    const result = updateResourceSchema.safeParse({ city: null });
    expect(result.success).toBe(true);
  });
});
