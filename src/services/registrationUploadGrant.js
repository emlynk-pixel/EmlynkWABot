// Registration upload grant (REGISTRATION_DESK).
//
// The registration desk may register a new candidate and upload that
// candidate's registration documents, and nothing else: no reading, editing
// or managing existing candidates. Nothing stored says who registered a
// candidate, so POST /api/admin/candidates hands the desk a short-lived grant
// for the candidate it just created; the upload routes accept a desk request
// only with that grant (src/routes/admin.js).
//
// The grant is a JWT signed with a key derived from JWT_SECRET for this one
// purpose, so it is never accepted as a sign-in token and a sign-in token is
// never accepted as a grant.

import crypto from "crypto";
import jwt from "jsonwebtoken";

// The documents the registration form uploads (CandidateRegistrationPage.tsx).
export const REGISTRATION_UPLOAD_TYPES = Object.freeze(["PASSPORT", "NIC", "SKILL_VIDEO"]);

// Long enough to upload a skill video on a slow connection.
export const REGISTRATION_UPLOAD_GRANT_SECONDS = 30 * 60;

// The request header the grant is sent in.
export const REGISTRATION_UPLOAD_HEADER = "X-Registration-Upload";

const PURPOSE = "candidate-registration-upload";
const ALGORITHM = "HS256";

function grantKey(secret = process.env.JWT_SECRET) {
    return crypto.createHmac("sha256", String(secret)).update(PURPOSE).digest();
}

export function issueRegistrationUploadGrant({ adminId, passportId }) {
    return jwt.sign({ adminId, passportId }, grantKey(), {
        algorithm: ALGORITHM,
        audience: PURPOSE,
        expiresIn: REGISTRATION_UPLOAD_GRANT_SECONDS,
    });
}

// True only for an unexpired grant issued to this admin for this candidate.
export function isValidRegistrationUploadGrant(grant, { adminId, passportId }) {
    if (typeof grant !== "string" || grant === "") return false;
    try {
        const claims = jwt.verify(grant, grantKey(), { algorithms: [ALGORITHM], audience: PURPOSE });
        return claims.adminId === adminId && claims.passportId === passportId;
    } catch {
        return false;
    }
}
