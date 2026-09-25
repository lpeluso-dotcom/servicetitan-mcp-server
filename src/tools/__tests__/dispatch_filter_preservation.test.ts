import { describe, it } from 'vitest';
import type { ToolDef } from '../index';
import { get_technician_shifts } from '../dispatch/get_technician_shifts';
import { list_non_job_events } from '../dispatch/list_non_job_events';
import { assertFilterPreservation } from './filter_preservation_helper';

describe('get_technician_shifts — filter preservation', () => {
  it('forwards every declared filter under the ST param name ST honors', async () => {

    await assertFilterPreservation(get_technician_shifts as ToolDef<any>, {
      technicianId:    { value: 11111111, expect: 'forwarded_query' },
      startsOnOrAfter: { value: '2026-07-05T00:00:00Z', expect: 'forwarded_query' },
      
      startsBefore:    { value: '2026-07-12T00:00:00Z', expect: 'forwarded_query', key: 'endsOnOrBefore' },
    });
  });
});

describe('list_non_job_events — filter preservation', () => {
  it('forwards every declared filter under the ST param name ST honors', async () => {
    await assertFilterPreservation(list_non_job_events, {
      technicianId:    { value: 11111111, expect: 'forwarded_query' },
      startsOnOrAfter: { value: '2026-07-05T00:00:00Z', expect: 'forwarded_query' },
      
      startsBefore:    { value: '2026-07-12T00:00:00Z', expect: 'forwarded_query', key: 'startsOnOrBefore' },
    });
  });
});
