import http from "k6/http";
import { check } from "k6";


export const options = {
  scenarios: {
    candidate_form_submit: {
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
  if (!TOKEN) {
    throw new Error("CANDIDATE_FORM_TOKEN is required");
  }

  const unique = `${__VU}-${__ITER}-${Date.now()}`;

  const payload = JSON.stringify({
    answers: {
      basic: {
        fullName: `LOAD TEST ${unique}`,
        surname: "Testing",
        otherNames: `Candidate-${unique}`,
        sex: "MALE",
        civilStatus: "SINGLE",
        birthDate: "2003-04-14",
        birthPlace: "LOADTEST",
      },

      contact: {
        address: "349/07/A PALANWATTA, LOAD TEST",
        city: "TESTING",
        district: "LOAD",
        dsDivision: "COLOMBO TESTING",
        gnDivision: "NA",
        alternativePhone: "0112532685",
        email: `loadtest-${unique}@example.com`,
      },

      passport: {
        issueDate: "2026-03-25",
        expiryDate: "2031-10-29",
      },

      qualifications: {
        jobCategory: "GYPSUM WORKER",
        jobCategoryOther: null,
        experience: "1Y",
        otherSkills1: "N/A",
        otherSkills2: "N/A",
        englishKnowledge: "VERY GOOD",
      },

      measurements: {
        shirtSize: "L",
        waistSize: "32",
        shoeSize: "8",
      },

      family: {
        father: {
          name: "N/A",
          surname: "N/A",
          passportNumber: "N/A",
          birthDate: null,
        },
        mother: {
          name: "N/A",
          surname: "N/A",
          passportNumber: null,
          birthDate: null,
        },
        spouse: {
          name: null,
          surname: null,
          passportNumber: null,
          birthDate: null,
        },
        child1: "N/A",
        child2: null,
        child3: null,
      },

      guardian: {
        name: "NA",
        relationship: "NA",
        nic: "901234567V",
        birthDate: "2026-10-02",
        phone: "+94771234567",
        address: "NA",
      },
    },

    idempotencyKey: `${__VU}-${__ITER}-${Date.now()}`,
  });

  const res = http.post(
    `${BASE_URL}/api/public/candidate-details/submit`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      tags: {
        name: "POST /api/public/candidate-details/submit",
      },
    }
  );

  check(res, {
    "status is 200": (r) => r.status === 200,

    "has submittedAt": (r) => {
      try {
        return Boolean(r.json("submittedAt"));
      } catch {
        return false;
      }
    },
  });

  if (res.status !== 200) {
    console.log(
      `SUBMIT FAIL status=${res.status} vu=${__VU} iter=${__ITER} body=${res.body}`
    );
  }
}