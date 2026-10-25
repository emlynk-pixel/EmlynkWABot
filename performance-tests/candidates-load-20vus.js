import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 20,
  duration: '1m',

  thresholds: {
    'http_req_failed{name:GET /api/admin/candidates}': ['rate<0.01'],
    'http_req_duration{name:GET /api/admin/candidates}': ['p(95)<3000'],
  },
};

export function setup() {
  const loginRes = http.post(
    `${__ENV.SUPABASE_URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({
      email: __ENV.TEST_EMAIL,
      password: __ENV.TEST_PASSWORD,
    }),
    {
      headers: {
        apikey: __ENV.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
    }
  );

  check(loginRes, {
    'login returns 200': (r) => r.status === 200,
  });

  return {
    token: loginRes.json('access_token'),
  };
}

export default function (data) {
  const res = http.get(
    `${__ENV.BASE_URL}/api/admin/candidates?page=1&pageSize=1&search=N487569`,
    {
      headers: {
        Authorization: `Bearer ${data.token}`,
      },
      tags: {
        name: 'GET /api/admin/candidates',
      },
    }
  );

  console.log(
  `Candidates: total=${res.timings.duration.toFixed(2)}ms ` +
  `waiting=${res.timings.waiting.toFixed(2)}ms ` +
  `connecting=${res.timings.connecting.toFixed(2)}ms ` +
  `receiving=${res.timings.receiving.toFixed(2)}ms`
);

if (res.status !== 200) {
  console.log(`CANDIDATE FAIL status=${res.status}`);
}

  check(res, {
    'candidates returns 200': (r) => r.status === 200,
  });

  sleep(1);
}