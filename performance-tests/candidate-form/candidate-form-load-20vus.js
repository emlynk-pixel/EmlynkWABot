import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    candidate_form_load: {
      executor: "per-vu-iterations",
      vus: 20,
      iterations: 50,
      maxDuration: "10m",
    },
  },

  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<6000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.CANDIDATE_FORM_TOKEN;

export default function () {
  const res = http.post(
    `${BASE_URL}/api/public/candidate-details/form`,
    JSON.stringify({}),
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      tags: {
        name: "POST /api/public/candidate-details/form",
      },
    }
  );

  check(res, {
    "status is 200": (r) => r.status === 200,
  });

  if (res.status !== 200) {
    console.log(
      `FORM LOAD FAIL status=${res.status} vu=${__VU} iter=${__ITER} body=${res.body}`
    );
  }
}