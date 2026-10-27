// CF-01: 20 different candidates submit their own Candidate Form at the same time.
//   setup     one candidate after another (lib.js verifyAndOpen: sequential, staggered), each
//             verifies through their OWN share link (their own token) and opens the form; then the
//             pool counters are reset, right before the submit burst. Not measured by the thresholds.
//   default   20 VUs x 1 iteration: VU n submits candidate n's form exactly once
//   teardown  candidate 1 tries a second submission, which must be refused (409 ALREADY_SUBMITTED)
// Run it through scripts/loadtest/runCandidateForm.mjs (creates the candidates and links).
import { SUBMIT_NAME, finish, loadTargets, prepareSessions, submitOnce } from './lib.js';

const VUS = 20;
const targets = loadTargets(VUS);

export const options = {
  // 20 sequential verify + form pairs with a pause between candidates.
  setupTimeout: '5m',
  scenarios: {
    twenty_candidates: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '3m' },
  },
  thresholds: {
    [`http_req_failed{name:${SUBMIT_NAME}}`]: ['rate<0.01'],
    [`http_req_duration{name:${SUBMIT_NAME}}`]: ['p(95)<6000'],
    cf_submit_200: [`count==${VUS}`],
    cf_lock_probe_409: ['count==1'],
  },
};

export function setup() { return prepareSessions(targets); }

export default function (data) { submitOnce(data.sessions[__VU - 1]); }

export function teardown(data) { finish(data); }
