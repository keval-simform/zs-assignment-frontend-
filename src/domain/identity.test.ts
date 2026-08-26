import { describe, expect, it } from '@jest/globals';
import { asFlatIndex, asRegionIndex, asRowKey, asTerritoryIndex } from './identity';

describe('branded identities', () => {
  it('accepts non-negative safe integers', () => {
    expect(asRowKey(0)).toBe(0);
    expect(asRowKey(49_999)).toBe(49_999);
    expect(asFlatIndex(7)).toBe(7);
    expect(asRegionIndex(5)).toBe(5);
    expect(asTerritoryIndex(47)).toBe(47);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['beyond safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('rejects %s input', (_label, value) => {
    expect(() => asRowKey(value)).toThrow(RangeError);
  });

  it('names the identity kind in the error so a misuse is diagnosable', () => {
    expect(() => asTerritoryIndex(-1)).toThrow(/TerritoryIndex/);
    expect(() => asFlatIndex(-1)).toThrow(/FlatIndex/);
  });
});
