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

// Additional Details as the public API will exchange them (Task 3: the
// secure read and save do not exist yet). Exactly the 19 fields, in the
// server's names; blanks are null. Nothing else about the candidate is ever
// part of these shapes.
export type AdditionalDetailsPayload = {
    nameAsInPassport: string | null;
    permanentAddress: string | null;
    birthday: string | null; // YYYY-MM-DD
    tshirtSize: string | null;
    pantSize: string | null;
    shoeSize: string | null;
    fatherAlive: boolean | null;
    fatherFullName: string | null;
    fatherBirthday: string | null;
    motherAlive: boolean | null;
    motherFullName: string | null;
    motherBirthday: string | null;
    maritalStatus: string | null;
    wifeFullName: string | null;
    wifeBirthday: string | null;
    child1Name: string | null;
    child2Name: string | null;
    child3Name: string | null;
    otherJobSkills: string | null;
};

// Planned (Task 3), not implemented on the server yet:
//   GET /api/public/candidate-details/details -> AdditionalDetailsResponse
//   PUT /api/public/candidate-details/details  { ...AdditionalDetailsPayload, expectedUpdatedDate }
// Both authorised by the candidate token in the Authorization header.
export type AdditionalDetailsResponse = {
    details: AdditionalDetailsPayload | null;
    updatedDate: string | null;
};
