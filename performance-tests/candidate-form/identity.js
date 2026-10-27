// Identities and answers of the Candidate Form load tests. Plain JavaScript with no k6 imports, so
// both k6 (lib.js) and the Node runner (scripts/loadtest/runCandidateForm.mjs) use the same values:
// the runner creates the candidates with them and checks every answer set with the server's own
// parseSubmission before k6 starts.
//
// A namespace of its own, so it can never meet the registration tests (P9.., 990000.., +9499..)
// or the seeded candidates:
//   passportId  N9 + 6 digits        (registration rule: P or N + 7 digits)
//   nic         980000 + 6 digits    (12-digit NIC)
//   whatsapp    +9498 + 7 digits     (stored as digits: 9498...)
//   names       LOADTEST / CF + the 6 digits
// seq = CF_RUN_ID * 10000 + (n - 1) for candidate n (1..): inside the run's own block of 10000
// (the runner checks those identities are free before a run). Each scenario has its own run ID.

export const MAX_CANDIDATES = 1000;
export const PASSPORT_PREFIX = 'N9';
export const NIC_PREFIX = '980000';
export const WHATSAPP_PREFIX = '9498';

const pad = (value, width) => String(value).padStart(width, '0');

export function seqFor(runId, n) {
  if (n < 1 || n > MAX_CANDIDATES) throw new Error(`identity out of range: candidate ${n} (max ${MAX_CANDIDATES})`);
  return Number(runId) * 10000 + (n - 1);
}

export function identityFor(runId, n) {
  const seq = seqFor(runId, n);
  const digits = pad(seq, 6);
  return {
    passportId: `${PASSPORT_PREFIX}${digits}`,
    nic: `${NIC_PREFIX}${digits}`,
    whatsappNumber: `+${WHATSAPP_PREFIX}${pad(seq, 7)}`,
    surname: 'LOADTEST',
    otherNames: `CF${digits}`,
  };
}

// The candidate's answers: every required field, fixed dates in the past, single (no spouse),
// "N/A" only where the form allows it, and unique text per candidate.
export function answersFor(runId, n, jobCategory) {
  const id = identityFor(runId, n);
  const digits = id.otherNames.slice(2);
  return {
    basic: {
      fullName: `CF${digits} LOADTEST`,
      surname: 'LOADTEST',
      otherNames: `CF${digits}`,
      sex: 'MALE',
      civilStatus: 'SINGLE',
      birthDate: '1995-01-15',
      birthPlace: 'COLOMBO',
    },
    contact: {
      address: `${digits} LOAD TEST ROAD`,
      city: 'COLOMBO',
      district: 'COLOMBO',
      dsDivision: 'COLOMBO',
      gnDivision: 'COLOMBO',
      alternativePhone: `+${WHATSAPP_PREFIX}${pad(seqFor(runId, n), 7)}`,
      email: `loadtest.cf${digits}@example.com`,
    },
    passport: { issueDate: '2024-01-10', expiryDate: '2034-01-09' },
    qualifications: {
      jobCategory,
      jobCategoryOther: null,
      experience: '2 YEARS',
      otherSkills1: 'N/A',
      otherSkills2: 'N/A',
      englishKnowledge: 'GOOD',
    },
    measurements: { shirtSize: 'L', waistSize: '32', shoeSize: '8' },
    family: {
      father: { name: 'N/A', surname: null, passportNumber: null, birthDate: null },
      mother: { name: 'N/A', surname: null, passportNumber: null, birthDate: null },
      spouse: { name: null, surname: null, passportNumber: null, birthDate: null },
      child1: 'N/A',
      child2: null,
      child3: null,
    },
    guardian: {
      name: `GUARDIAN CF${digits}`,
      relationship: 'BROTHER',
      nic: `196500${digits}`,
      birthDate: '1965-05-20',
      phone: '+94112532685',
      address: `${digits} LOAD TEST ROAD`,
    },
  };
}

// 16..64 characters of [A-Za-z0-9_-]; one key per candidate and run.
export const idempotencyKeyFor = (runId, n) => `loadtest-cf-${pad(seqFor(runId, n), 6)}`;

export const submitBodyFor = (runId, n, jobCategory) => ({ answers: answersFor(runId, n, jobCategory), idempotencyKey: idempotencyKeyFor(runId, n) });
