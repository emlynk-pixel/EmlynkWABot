// Shapes of the public Candidate Extra Details API (/api/public/candidate-details).

// The share link's secret (from the URL fragment) + the candidate's own
// Passport Number and NIC.
export type VerifyRequest = {
    linkSecret: string;
    passportNumber: string;
    nic: string;
};

// A successful verification returns only the short-lived token and its expiry.
export type VerifyResponse = {
    token: string;
    expiresAt: string;
};

export type FieldError = { field: string; message: string };

export type ApiErrorBody = {
    message?: string;
    code?: string;
    errors?: FieldError[];
};


// The Candidate Form's answers, as sent to POST /submit and returned
// (as the prefill) by POST /form. Blanks are null; choices are English codes.
// It never holds the Passport Number or the NIC: those are the verified
// identity, taken from the candidate's record by the server. Nothing
// staff-only (register number, stages, allocation, jobs, documents).
type Nullable<T> = { [K in keyof T]: string | null };
type Person = Nullable<{ name: string; surname: string; passportNumber: string; birthDate: string }>;

export type CandidateFormPayload = {
    basic: Nullable<{ fullName: string; surname: string; otherNames: string; sex: string; civilStatus: string; birthDate: string; birthPlace: string }>;
    contact: Nullable<{ address: string; city: string; district: string; dsDivision: string; gnDivision: string; alternativePhone: string; email: string }>;
    passport: Nullable<{ issueDate: string; expiryDate: string }>;
    qualifications: Nullable<{ jobCategory: string; jobCategoryOther: string; experience: string; otherSkills1: string; otherSkills2: string; englishKnowledge: string }>;
    measurements: Nullable<{ shirtSize: string; waistSize: string; shoeSize: string }>;
    family: { father: Person; mother: Person; spouse: Person; child1: string | null; child2: string | null; child3: string | null };
    guardian: Nullable<{ name: string; relationship: string; nic: string; birthDate: string; phone: string; address: string }>;
};

// POST /form: the verified identity (read-only), the prefill from the
// candidate's existing records, and which answers were prefilled.
export type FormLoadResponse = {
    identity: { passportNumber: string; nic: string; whatsappNumber: string | null };
    answers: CandidateFormPayload;
    prefilled: string[];
    // The ACTIVE job types (Settings > Job Types), names only: the job category choices.
    jobCategories: string[];
    expiresAt: string;
};

export type SubmitResponse = { submittedAt: string };
