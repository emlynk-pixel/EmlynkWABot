// REG-02: 5 concurrent registrations. 5 VUs x 10 registrations, back to back, so the first five
// requests start together and the rest keep overlapping. Every payload is unique (lib.js).
// Exposes the known unique_id race (nextUniqueId) as 503 TRY_AGAIN, reported separately.
import { ENDPOINT_NAME, register, requireToken } from './lib.js';

export const options = {
  scenarios: {
    five_vus: { executor: 'per-vu-iterations', vus: 5, iterations: 10, maxDuration: '3m' },
  },
  thresholds: {
    [`http_req_failed{name:${ENDPOINT_NAME}}`]: ['rate<0.01'],
    [`http_req_duration{name:${ENDPOINT_NAME}}`]: ['p(95)<4000'],
  },
};

export function setup() { requireToken(); }

export default function () { register(); }
