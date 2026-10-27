// REG-03: 10 concurrent registrations. 10 VUs x 10 registrations, back to back, so the first ten
// requests start together and the rest keep overlapping. Every payload is unique (lib.js), with the
// same checks and outcome counters as REG-02.
import { ENDPOINT_NAME, register, requireToken } from './lib.js';

export const options = {
  scenarios: {
    ten_vus: { executor: 'per-vu-iterations', vus: 10, iterations: 10, maxDuration: '5m' },
  },
  thresholds: {
    [`http_req_failed{name:${ENDPOINT_NAME}}`]: ['rate<0.01'],
    [`http_req_duration{name:${ENDPOINT_NAME}}`]: ['p(95)<5000'],
  },
};

export function setup() { requireToken(); }

export default function () { register(); }
