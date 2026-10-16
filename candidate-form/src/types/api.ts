// Shapes of the public Candidate Extra Details API (/api/public/candidate-details).

export type VerifyRequest = {
    passportNumber: string;
    whatsappNumber: string;
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


// The Candidate Form as it would be sent once the secure save exists
// (Task 3, not implemented on the server yet; the server side will confirm
// this shape). Blanks are null; choices are English codes. It never holds
// the Passport Number or WhatsApp Number: the server knows the candidate
// from the token. Nothing staff-only (register number, stages, allocation,
// jobs, documents) is part of it.
type Nullable<T> = { [K in keyof T]: string | null };

export type CandidateFormPayload = {
    basic: Nullable<{ fullName: string; surname: string; otherNames: string; nic: string; sex: string; civilStatus: string; birthDate: string; birthPlace: string }>;
    contact: Nullable<{ address: string; city: string; district: string; dsDivision: string; gnDivision: string; alternativePhone: string; email: string }>;
    passport: Nullable<{ issueDate: string; expiryDate: string }>;
    qualifications: Nullable<{ jobCategory: string; jobCategoryOther: string; experience: string; otherSkills1: string; otherSkills2: string; englishKnowledge: string }>;
    measurements: Nullable<{ shirtSize: string; waistSize: string; shoeSize: string }>;
    family: {
        father: Nullable<{ name: string; surname: string; passportNumber: string; birthDate: string }>;
        mother: Nullable<{ name: string; surname: string; passportNumber: string; birthDate: string }>;
        spouse: Nullable<{ name: string; surname: string; passportNumber: string; birthDate: string }>;
        child1: string | null;
        child2: string | null;
        child3: string | null;
    };
    guardian: Nullable<{ name: string; relationship: string; nic: string; birthDate: string; phone: string; address: string }>;
};
