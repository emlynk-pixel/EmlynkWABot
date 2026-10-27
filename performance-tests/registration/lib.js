// Shared pieces of the Candidate Registration load tests (POST /api/admin/candidates).
//
// Environment (nothing is hardcoded; the token is minted by scripts/loadtest/runRegistration.mjs):
//   BASE_URL      the local backend started with `npm run loadtest:backend` (default http://localhost:3000)
//   ACCESS_TOKEN  an ADMIN's Supabase access token for the LOAD-TEST project
//   RUN_ID        0..99, part of every generated identity so runs never collide (default 1)
//   JOB_TYPE      an ACTIVE job type name (default BARBENDER)
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

export const ENDPOINT_NAME = 'POST /api/admin/candidates';

// Outcome counters, so each kind of response is reported separately.
export const reg201 = new Counter('reg_201');
export const reg409 = new Counter('reg_409');
export const reg429 = new Counter('reg_429');
export const reg503 = new Counter('reg_503');
export const reg5xxOther = new Counter('reg_5xx_other');
export const regOther = new Counter('reg_other_status');
export const codeCandidateExists = new Counter('reg_code_CANDIDATE_EXISTS');
export const codeNicExists = new Counter('reg_code_NIC_EXISTS');
export const codeWhatsappExists = new Counter('reg_code_WHATSAPP_EXISTS');
export const codeTryAgain = new Counter('reg_code_TRY_AGAIN');

const pad = (value, width) => String(value).padStart(width, '0');

// Deterministic, unique per (RUN_ID, VU, iteration). Recognisable namespace that cannot meet the
// seeded candidates (P0000001.., LTN.. NICs, 94770.. numbers) and satisfies the current validation:
//   passportId  P9 + 6 digits                  (P or N + 7 digits)
//   nic         990000 + 6 digits              (12-digit NIC)
//   whatsapp    +9499 + 7 digits               (8-15 digits, unique among candidates)
//   names       LOADTEST / REG + the 6 digits
// seq = RUN_ID * 10000 + (VU - 1) * 1000 + iteration, so up to 10 VUs x 1000 iterations per run.
export function identityFor(runId, vu, iteration) {
  const seq = Number(runId) * 10000 + (vu - 1) * 1000 + iteration;
  const digits = pad(seq, 6);
  return {
    passportId: `P9${digits}`,
    nic: `990000${digits}`,
    whatsappNumber: `+9499${pad(seq, 7)}`,
    surname: 'LOADTEST',
    otherNames: `REG${digits}`,
  };
}

export function payloadFor(runId, vu, iteration, jobType) {
  return { ...identityFor(runId, vu, iteration), jobTypes: [jobType] };
}

export function requireToken() {
  if (!__ENV.ACCESS_TOKEN) {
    throw new Error('ACCESS_TOKEN is not set. Run the scenario through scripts/loadtest/runRegistration.mjs.');
  }
}

// One registration, with every check and the status / error-code counters.
export function register() {
  const runId = __ENV.RUN_ID || '1';
  const jobType = __ENV.JOB_TYPE || 'BARBENDER';
  const res = http.post(
    `${__ENV.BASE_URL || 'http://localhost:3000'}/api/admin/candidates`,
    JSON.stringify(payloadFor(runId, __VU, __ITER, jobType)),
    {
      headers: { Authorization: `Bearer ${__ENV.ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      tags: { name: ENDPOINT_NAME },
    },
  );

  let body = {};
  try { body = res.json() || {}; } catch (e) { body = {}; }

  if (res.status === 201) reg201.add(1);
  else if (res.status === 409) reg409.add(1);
  else if (res.status === 429) reg429.add(1);
  else if (res.status === 503) reg503.add(1);
  else if (res.status >= 500) reg5xxOther.add(1);
  else regOther.add(1);
  if (body.code === 'CANDIDATE_EXISTS') codeCandidateExists.add(1);
  if (body.code === 'NIC_EXISTS') codeNicExists.add(1);
  if (body.code === 'WHATSAPP_EXISTS') codeWhatsappExists.add(1);
  if (body.code === 'TRY_AGAIN') codeTryAgain.add(1);

  check(res, {
    'status is 201': (r) => r.status === 201,
    'has passportId': () => typeof body.passportId === 'string' && body.passportId.length > 0,
    'has uniqueId': () => typeof body.uniqueId === 'string' && body.uniqueId.length > 0,
    'no CANDIDATE_EXISTS': () => body.code !== 'CANDIDATE_EXISTS',
    'no NIC_EXISTS': () => body.code !== 'NIC_EXISTS',
    'no WHATSAPP_EXISTS': () => body.code !== 'WHATSAPP_EXISTS',
    'no TRY_AGAIN': () => body.code !== 'TRY_AGAIN',
  });

  if (res.status !== 201) {
    console.log(`REG FAIL status=${res.status} code=${body.code || '-'} vu=${__VU} iter=${__ITER}`);
  }
  return res;
}
