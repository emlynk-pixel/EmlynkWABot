import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  // 1. Login through Supabase
  const loginUrl = `${__ENV.SUPABASE_URL}/auth/v1/token?grant_type=password`;

  const loginPayload = JSON.stringify({
    email: __ENV.TEST_EMAIL,
    password: __ENV.TEST_PASSWORD,
  });

  const loginRes = http.post(loginUrl, loginPayload, {
    headers: {
      apikey: __ENV.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
  });

  const loginOk = check(loginRes, {
    'login returns 200': (r) => r.status === 200,
    'access token exists': (r) => {
      try {
        return Boolean(r.json('access_token'));
      } catch {
        return false;
      }
    },
  });

  if (!loginOk) {
    return;
  }

  const token = loginRes.json('access_token');

  // 2. Call protected backend API
  const candidatesRes = http.get(
    `${__ENV.BASE_URL}/api/admin/candidates`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  check(candidatesRes, {
    'candidates returns 200': (r) => r.status === 200,
  });
}