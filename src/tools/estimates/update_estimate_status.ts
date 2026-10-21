// Estimate status-change action tools.
//
// ServiceTitan exposes status transitions only through PUT action endpoints:
//   PUT /sales/v2/tenant/{tid}/estimates/{id}/dismiss   (empty body)
//   PUT /sales/v2/tenant/{tid}/estimates/{id}/sell      ({ soldBy })
//   PUT /sales/v2/tenant/{tid}/estimates/{id}/unsell    (empty body)
//
// An estimate that is already inactive (for example the source side of a UI
// "duplicate estimate") can make these calls fail with an upstream error; the
// error is returned as-is.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface DismissArgs {
  estimateId: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

interface SellArgs {
  estimateId: number;
  soldBy: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

interface UnsellArgs {
  estimateId: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const dismiss_estimate = defineWriteTool<DismissArgs>({
  name: 'dismiss_estimate',
  description: 'Dismiss an estimate (status → Dismissed). dryRun=true (default) → token → dryRun=false to write. Source: live ST.',
  zodSchema: {
    estimateId: z.number().int().positive().describe('ST estimate ID'),
  },
  endpoint: ({ estimateId }) => `/sales/v2/tenant/000000000/estimates/${estimateId}/dismiss`,
  method: 'PUT',
  payload: () => ({}),
  businessArgs: ({ estimateId }) => ({ estimateId }),
  stEndpointTemplate: '/sales/v2/tenant/{tid}/estimates/{estimateId}/dismiss',
});

export const sell_estimate = defineWriteTool<SellArgs>({
  name: 'sell_estimate',
  description: 'Mark an estimate Sold. Requires soldBy technicianId — ST rejects without it. dryRun=true (default) → token → dryRun=false to write. Source: live ST.',
  zodSchema: {
    estimateId: z.number().int().positive().describe('ST estimate ID'),
    soldBy: z.number().int().positive().describe('Technician ID who sold the estimate'),
  },
  endpoint: ({ estimateId }) => `/sales/v2/tenant/000000000/estimates/${estimateId}/sell`,
  method: 'PUT',
  payload: ({ soldBy }) => ({ soldBy }),
  businessArgs: ({ estimateId, soldBy }) => ({ estimateId, soldBy }),
  stEndpointTemplate: '/sales/v2/tenant/{tid}/estimates/{estimateId}/sell',
});

export const unsell_estimate = defineWriteTool<UnsellArgs>({
  name: 'unsell_estimate',
  description: 'Revert a Sold estimate back to Open. dryRun=true (default) → token → dryRun=false to write. Source: live ST.',
  zodSchema: {
    estimateId: z.number().int().positive().describe('ST estimate ID'),
  },
  endpoint: ({ estimateId }) => `/sales/v2/tenant/000000000/estimates/${estimateId}/unsell`,
  method: 'PUT',
  payload: () => ({}),
  businessArgs: ({ estimateId }) => ({ estimateId }),
  stEndpointTemplate: '/sales/v2/tenant/{tid}/estimates/{estimateId}/unsell',
});
