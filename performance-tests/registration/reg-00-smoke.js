// REG-00: registration smoke. One request; must be HTTP 201 with passportId and uniqueId.
import { register, requireToken } from './lib.js';

export const options = {
  scenarios: {
    smoke: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '1m' },
  },
  thresholds: {
    checks: ['rate==1'],
    reg_201: ['count==1'],
  },
};

export function setup() { requireToken(); }

export default function () { register(); }
