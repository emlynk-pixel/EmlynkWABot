// REG-04: 20 concurrent registrations. 20 VUs x 10 registrations, back to back, so the first twenty
// requests start together and the rest keep overlapping. Every payload is unique (lib.js), with the
// same checks and outcome counters as REG-02 / REG-03.
import { ENDPOINT_NAME, register, requireToken } from './lib.js';

export const options = {
  scenarios: {
    twenty_vus: { executor: 'per-vu-iterations', vus: 20, iterations: 10, maxDuration: '8m' },
  },
  thresholds: {
    [`http_req_failed{name:${ENDPOINT_NAME}}`]: ['rate<0.01'],
    [`http_req_duration{name:${ENDPOINT_NAME}}`]: ['p(95)<5000'],
  },
};

export function setup() { requireToken(); }

export default function () { register(); }
