import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  duration: '30s',

  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';

  const response = http.get(`${baseUrl}/health`);

  check(response, {
    'health returns 200': (r) => r.status === 200,
    'response time below 1 second': (r) => r.timings.duration < 1000,
  });

  sleep(1);
}