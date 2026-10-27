// REG-01: registration baseline. One VU, 20 sequential registrations, no think time:
// the normal, uncontended latency of POST /api/admin/candidates.
import { ENDPOINT_NAME, register, requireToken } from './lib.js';

export const options = {
  scenarios: {
    baseline: { executor: 'per-vu-iterations', vus: 1, iterations: 20, maxDuration: '3m' },
  },
  thresholds: {
    [`http_req_failed{name:${ENDPOINT_NAME}}`]: ['rate<0.01'],
    [`http_req_duration{name:${ENDPOINT_NAME}}`]: ['p(95)<3000'],
  },
};

export function setup() { requireToken(); }

export default function () { register(); }
