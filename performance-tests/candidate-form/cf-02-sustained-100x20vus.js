// CF-02: sustained Candidate Form submissions. 100 different candidates submit their own form over
// time, at most 20 at once (links sent to many candidates are not all submitted in the same second).
//   setup     one candidate after another (lib.js verifyAndOpen: sequential, staggered), each of the
//             100 verifies through their OWN share link (their own token) and opens the form; then
//             the pool counters are reset, right before the submission phase. Not measured.
//   default   shared-iterations: 20 VUs work through 100 iterations; each iteration submits the next
//             unused candidate exactly once (lib.js submitNext), so 20 are in flight until the end.
//   teardown  submission-phase wall time, then candidate 1's second submission must be refused (409).
// Reliability first: the counts below are hard thresholds; latency is reported by the runner and
// gated there separately, so a small latency miss is never a data-integrity failure.
// Run it through scripts/loadtest/runCandidateForm.mjs (creates the candidates and links).
import { SUBMIT_NAME, finish, loadTargets, prepareSessions, submitNext } from './lib.js';

const CANDIDATES = 100;
const VUS = 20;
const targets = loadTargets(CANDIDATES);

export const options = {
  // 100 sequential verify + form pairs with a pause between candidates (~3-5 minutes).
  setupTimeout: '15m',
  scenarios: {
    sustained_submissions: { executor: 'shared-iterations', vus: VUS, iterations: CANDIDATES, maxDuration: '10m' },
  },
  thresholds: {
    [`http_req_failed{name:${SUBMIT_NAME}}`]: ['rate<0.01'],
    cf_submit_200: [`count==${CANDIDATES}`],
    cf_lock_probe_409: ['count==1'],
  },
};

export function setup() { return prepareSessions(targets); }

export default function (data) { submitNext(data); }

export function teardown(data) { finish(data); }
