import { describe, it, expect } from 'vitest';
import { CATALOG_PAGE_SIZE, CATALOG_MAX_PAGES } from '../catalog-scan';

describe('catalog-scan budget sizing', () => {
  it('CATALOG_PAGE_SIZE keeps the largest measured live page (equipment) at or under ~800 KB', () => {

    const WORST_MEASURED_BYTES_PER_ROW = 3215.4;
    const BYTE_TARGET = 800_000;
    expect(CATALOG_PAGE_SIZE * WORST_MEASURED_BYTES_PER_ROW).toBeLessThanOrEqual(BYTE_TARGET);
  });

  it('CATALOG_MAX_PAGES keeps search_pricebook_all\'s worst case (narrowed scan + full fallback rescan, 3 catalogs each) within the 100-call request budget', () => {
    const KINDS = 3;
    const ROUNDS = 2; 
    const REQUEST_UPSTREAM_CAP = 100;
    expect(ROUNDS * KINDS * CATALOG_MAX_PAGES).toBeLessThanOrEqual(REQUEST_UPSTREAM_CAP);
  });

  it('pins the exact values the sizing above assumes', () => {
    
    
    expect(CATALOG_PAGE_SIZE).toBe(200);
    expect(CATALOG_MAX_PAGES).toBe(16);
  });
});
