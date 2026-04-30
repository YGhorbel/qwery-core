import { describe, it, expect } from 'vitest';
import { extractKeywords } from '../src/tools/get-semantic-context.js';

describe('extractKeywords', () => {
  it('extracts revenue from a typical question', () => {
    expect(extractKeywords('what was our revenue last month?')).toEqual([
      'revenue',
    ]);
  });

  it('extracts multiple fields correctly', () => {
    expect(extractKeywords('show revenue by country')).toEqual([
      'revenue',
      'country',
    ]);
  });

  it('strips temporal expressions', () => {
    const result = extractKeywords('revenue last month by quarter');
    expect(result).toContain('revenue');
    expect(result).not.toContain('month');
    expect(result).not.toContain('quarter');
    expect(result).not.toContain('last');
  });

  it('strips stop words', () => {
    const result = extractKeywords('what is our total revenue for this year');
    expect(result).toContain('revenue');
    expect(result).not.toContain('what');
    expect(result).not.toContain('our');
    expect(result).not.toContain('for');
    expect(result).not.toContain('this');
  });

  it('strips pronouns', () => {
    const result = extractKeywords('show me their active customers');
    expect(result).toContain('active');
    expect(result).toContain('customers');
    expect(result).not.toContain('show');
    expect(result).not.toContain('me');
    expect(result).not.toContain('their');
  });

  it('handles multi-word business concepts', () => {
    const result = extractKeywords('average basket size by product category');
    expect(result).toContain('average');
    expect(result).toContain('basket');
    expect(result).toContain('product');
    expect(result).toContain('category');
  });

  it('strips year numbers', () => {
    const result = extractKeywords('revenue in 2024 by region');
    expect(result).not.toContain('2024');
    expect(result).toContain('revenue');
    expect(result).toContain('region');
  });

  it('strips month names', () => {
    const result = extractKeywords('sales in january and february');
    expect(result).not.toContain('january');
    expect(result).not.toContain('february');
    expect(result).toContain('sales');
  });

  it('strips Q1/Q2/Q3/Q4 patterns', () => {
    const result = extractKeywords('profit margin in Q3');
    expect(result).not.toContain('q3');
    expect(result).toContain('profit');
    expect(result).toContain('margin');
  });

  it('handles raw column names', () => {
    const result = extractKeywords('show me s_price data');
    expect(result).toContain('s_price');
  });

  it('caps at 6 keywords', () => {
    const result = extractKeywords(
      'revenue profit margin customers orders products category country region',
    );
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('returns empty array for pure temporal question', () => {
    const result = extractKeywords('what happened last month this year in Q3');
    expect(result).toEqual([]);
  });

  it('handles empty string gracefully', () => {
    expect(extractKeywords('')).toEqual([]);
  });

  it('handles conversational non-data question', () => {
    const result = extractKeywords('how are you doing today');
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it('produces consistent results regardless of phrasing style', () => {
    const r1 = extractKeywords('revenue last month broken down by country').sort();
    const r2 = extractKeywords('total revenue for last month by country').sort();
    expect(r1).toContain('revenue');
    expect(r1).toContain('country');
    expect(r2).toContain('revenue');
    expect(r2).toContain('country');
  });
});
