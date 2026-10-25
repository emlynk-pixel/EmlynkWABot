import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '1m',

   thresholds: {
    'http_req_failed{name:GET /auth/me}': ['rate<0.01'],
    'http_req_duration{name:GET /auth/me}': ['p(95)<3000'],
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
    `${__ENV.BASE_URL}/auth/me`,
    {
      headers: {
        Authorization: `Bearer ${data.token}`,
      },
      tags: {
        name: 'GET /auth/me',
      },
    }
  );

console.log(
  `Auth me: total=${res.timings.duration.toFixed(2)}ms ` +
  `waiting=${res.timings.waiting.toFixed(2)}ms`
);

  check(res, {
    'Auth me returns 200': (r) => r.status === 200,
  });

  sleep(1);
}