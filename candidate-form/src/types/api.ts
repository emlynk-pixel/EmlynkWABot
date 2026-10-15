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
