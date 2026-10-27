// Shared pieces of the Candidate Form load tests (public routes /api/public/candidate-details/*).
//
// Environment (nothing is hardcoded; scripts/loadtest/runCandidateForm.mjs sets all of it):
//   BASE_URL         the local backend started with `npm run loadtest:backend` (default http://localhost:3000)
//   CF_TARGETS_FILE  JSON written by the runner: [{ n, passportId, nic, linkSecret }], one per candidate
//   CF_RUN_ID        0..99, part of every identity (identity.js)
//   JOB_TYPE         an ACTIVE job type name, the answers' job category
//   SIDECAR_URL      the backend's load-test metrics sidecar (pool counters are reset after setup)
// Real flow only: every candidate has their OWN share link, verifies with their OWN passport + NIC
// and gets their OWN form token; no token is ever used for another candidate.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Gauge } from 'k6/metrics';
import { submitBodyFor } from './identity.js';

const BASE = `${__ENV.BASE_URL || 'http://localhost:3000'}/api/public/candidate-details`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const VERIFY_NAME = 'POST /api/public/candidate-details/verify';
export const FORM_NAME = 'POST /api/public/candidate-details/form';
export const SUBMIT_NAME = 'POST /api/public/candidate-details/submit';
export const PROBE_NAME = 'POST /api/public/candidate-details/submit (lock probe)';

// Submit outcome counters, so each kind of response is reported separately.
export const submit200 = new Counter('cf_submit_200');
export const submit409 = new Counter('cf_submit_409');
export const submit429 = new Counter('cf_submit_429');
export const submit500 = new Counter('cf_submit_500');
export const submit503 = new Counter('cf_submit_503');
export const submit5xxOther = new Counter('cf_submit_5xx_other');
export const submitOther = new Counter('cf_submit_other_status');
export const codeAlreadySubmitted = new Counter('cf_code_ALREADY_SUBMITTED');
export const probe409 = new Counter('cf_lock_probe_409');
// Wall time of the measured submission phase (end of setup -> start of teardown), for throughput.
export const submitPhaseMs = new Gauge('cf_submit_phase_ms');

const bodyOf = (res) => { try { return res.json() || {}; } catch (e) { return {}; } };
const runId = () => __ENV.CF_RUN_ID || '1';
const jobType = () => __ENV.JOB_TYPE || 'BARBENDER';

export function loadTargets(candidates) {
  if (!__ENV.CF_TARGETS_FILE) throw new Error('CF_TARGETS_FILE is not set. Run the scenario through scripts/loadtest/runCandidateForm.mjs.');
  const targets = JSON.parse(open(__ENV.CF_TARGETS_FILE));
  if (targets.length !== candidates) throw new Error(`expected ${candidates} candidates, the targets file has ${targets.length}`);
  if (new Set(targets.map((t) => t.linkSecret)).size !== candidates || new Set(targets.map((t) => t.passportId)).size !== candidates) {
    throw new Error('every candidate must have its own share link');
  }
  return targets;
}

// Pause between two candidates' verifications in setup (seconds; CF_SETUP_STAGGER_S, default 0.5).
const SETUP_STAGGER_S = Number(__ENV.CF_SETUP_STAGGER_S || 0.5);

// Each candidate opens their own link, ONE AT A TIME: verify (link + passport + NIC -> their token),
// then the form (identity + prefill), then a short pause before the next candidate.
// Why sequential: the per-IP /verify limiter counts only failures, but express-rate-limit adds each
// request on arrival and takes a success off again only after its response. All 20 from k6's single
// IP at once therefore counted 20 in-flight hits against a limit of 10 (429 from the 11th on). One at
// a time, with the pause letting the success be taken off, the count stays at 0-1; the limiter itself
// is untouched. Any failure stops the test before a single submission.
export function verifyAndOpen(targets) {
  const sessions = [];
  for (const t of targets) {
    const res = http.post(`${BASE}/verify`, JSON.stringify({ linkSecret: t.linkSecret, passportNumber: t.passportId, nic: t.nic }), { headers: JSON_HEADERS, tags: { name: VERIFY_NAME } });
    const token = bodyOf(res).token;
    if (res.status !== 200 || typeof token !== 'string') throw new Error(`verify failed for candidate ${t.n}: HTTP ${res.status} ${bodyOf(res).code || ''}`);

    const form = http.post(`${BASE}/form`, '{}', { headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` }, tags: { name: FORM_NAME } });
    if (form.status !== 200) throw new Error(`form failed for candidate ${t.n}: HTTP ${form.status}`);
    if (bodyOf(form).identity?.passportNumber !== t.passportId) throw new Error(`candidate ${t.n}'s token opened another candidate's form`);

    sessions.push({ n: t.n, passportId: t.passportId, token });
    sleep(SETUP_STAGGER_S);
  }
  if (new Set(sessions.map((s) => s.token)).size !== sessions.length) throw new Error('two candidates received the same token');
  return sessions;
}

// The end of every scenario's setup: verify + open each candidate's form, then zero the backend's
// pool counters as the very last step, so the pool metrics the runner reads cover the submissions
// only. Returns the setup data (sessions + when the submission phase starts).
export function prepareSessions(targets) {
  const sessions = verifyAndOpen(targets);
  if (__ENV.SIDECAR_URL) http.post(`${__ENV.SIDECAR_URL}/reset`, null, { tags: { name: 'sidecar reset' } });
  return { sessions, submitPhaseStartedAt: Date.now() };
}

// The shared teardown: record the submission phase's wall time, then the second-submit lock probe.
export function finish(data) {
  submitPhaseMs.add(Date.now() - data.submitPhaseStartedAt);
  lockProbe(data.sessions[0]);
}

// Sustained mode (shared-iterations): each iteration, whichever VU runs it, takes the NEXT unused
// candidate. iterationInTest is unique across all VUs, so every candidate is submitted exactly once.
export function submitNext(data) {
  const index = exec.scenario.iterationInTest;
  if (index >= data.sessions.length) throw new Error(`iteration ${index} has no candidate (${data.sessions.length} prepared)`);
  return submitOnce(data.sessions[index]);
}

// The one submission of one candidate, with its own answers and idempotency key.
export function submitOnce(session) {
  const res = http.post(`${BASE}/submit`, JSON.stringify(submitBodyFor(runId(), session.n, jobType())), {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${session.token}` },
    tags: { name: SUBMIT_NAME },
  });
  const body = bodyOf(res);

  if (res.status === 200) submit200.add(1);
  else if (res.status === 409) submit409.add(1);
  else if (res.status === 429) submit429.add(1);
  else if (res.status === 500) submit500.add(1);
  else if (res.status === 503) submit503.add(1);
  else if (res.status > 500) submit5xxOther.add(1);
  else submitOther.add(1);
  if (body.code === 'ALREADY_SUBMITTED') codeAlreadySubmitted.add(1);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has submittedAt': () => typeof body.submittedAt === 'string' && !Number.isNaN(Date.parse(body.submittedAt)),
    'not 500': (r) => r.status !== 500,
    'not 409': (r) => r.status !== 409,
    'not 429': (r) => r.status !== 429,
    'not 503': (r) => r.status !== 503,
  });

  if (res.status !== 200) console.log(`SUBMIT FAIL status=${res.status} code=${body.code || '-'} candidate=${session.n} vu=${__VU}`);
  return res;
}

// After the run: candidate 1 tries a SECOND, different submission with their own token. The form
// is locked, so it must be refused with 409 ALREADY_SUBMITTED (nothing is written).
export function lockProbe(session) {
  const body = submitBodyFor(runId(), session.n, jobType());
  body.idempotencyKey = `${body.idempotencyKey}-again`;
  const res = http.post(`${BASE}/submit`, JSON.stringify(body), {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${session.token}` },
    tags: { name: PROBE_NAME },
    responseCallback: http.expectedStatuses(409),
  });
  const ok = res.status === 409 && bodyOf(res).code === 'ALREADY_SUBMITTED';
  if (ok) probe409.add(1);
  check(res, { 'second submit refused with ALREADY_SUBMITTED': () => ok });
}
