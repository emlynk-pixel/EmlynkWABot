import type { Tone } from "./StatusBadge";
import { humanize } from "./format";

// Review reason codes from the backend (src/services/reviewReason.js).
export const REVIEW_REASONS: Record<string, { label: string; description: string; tone: Tone }> = {
    PROCESSING_FAILED: { label: "Processing failed", description: "Processing stopped with an error; the file was kept.", tone: "critical" },
    CROSS_CLIENT_DUPLICATE: { label: "File belongs to another client", description: "The same file is already stored for a different client.", tone: "critical" },
    IDENTITY_CONFLICT: { label: "Identity conflict", description: "The passport and the sender's WhatsApp number point at different clients.", tone: "critical" },
    RECORD_CONFLICT: { label: "Differs from client record", description: "Values read from the passport differ from the client's record.", tone: "critical" },
    DOCUMENT_TYPE_UNCLEAR: { label: "Document type unclear", description: "The document type could not be determined from its content.", tone: "review" },
    WRONG_DOCUMENT_SUSPECTED: { label: "Wrong document suspected", description: "The file name and the content disagree about the document type.", tone: "review" },
    IDENTITY_NOT_CONFIRMED: { label: "Identity not confirmed", description: "The sender could not be confirmed as the client (see identity details).", tone: "review" },
    POLICE_DATE_UNRESOLVED: { label: "Police slip date unclear", description: "The submitted date on the police slip could not be read reliably.", tone: "review" },
    LOW_CONFIDENCE: { label: "Low confidence", description: "The document was read with low confidence and needs checking.", tone: "review" },
    DUPLICATE_OF_VERIFIED: { label: "Duplicate of a verified document", description: "This document is an exact duplicate of an existing verified document for this client. The existing document was not changed. Keep this item pending or remove it from review.", tone: "duplicate" },
};

export function reviewReasonLabel(reason: string | null): string {
    if (!reason) return "Not recorded";
    return REVIEW_REASONS[reason]?.label ?? humanize(reason);
}

export function reviewReasonTone(reason: string | null): Tone {
    return reason ? REVIEW_REASONS[reason]?.tone ?? "pending" : "pending";
}

export const IDENTITY_NOTES: Record<string, string> = {
    WHATSAPP_NOT_ON_RECORD: "The client has no WhatsApp number on record",
    WHATSAPP_DIFFERS: "The sender differs from the WhatsApp number on record",
    PASSPORT_NOT_IN_DATABASE: "The passport number is not in the client database",
    PASSPORT_ID_LOW_CONFIDENCE: "The passport number was read with low confidence",
};

export const CATEGORY_LABELS = { IDENTITY: "Identity issues", QUALITY: "Quality / OCR issues", CONFLICT: "Conflicts", OTHER: "Other" } as const;

// H3: why processing failed (backend src/services/failureReason.js).
export const FAILURE_REASONS: Record<string, { label: string; description: string }> = {
    PDF_TOO_MANY_PAGES: { label: "PDF has too many pages", description: "The PDF has more pages than the system reads. Ask the client to send only the needed pages." },
    PDF_PAGE_TOO_LARGE: { label: "PDF page too large", description: "A page of the PDF is too large to read. Ask the client for a smaller scan or a photo." },
    IMAGE_TOO_LARGE: { label: "Image too large", description: "The image is too large to read. Ask the client for a smaller photo." },
    IMAGE_UNREADABLE: { label: "Image could not be opened", description: "The image file could not be decoded. Ask the client to send it again." },
    OCR_BUSY: { label: "Text reading was busy", description: "Too many documents were being read at the same time. Ask the client to send the file again." },
    OCR_TIMEOUT: { label: "Text reading took too long", description: "Reading the text did not finish in time. Ask the client to send a clearer or smaller file." },
    TEXT_EXTRACTION_FAILED: { label: "Text could not be read", description: "Reading the document's text failed." },
    STORAGE_FAILED: { label: "Storing the file failed", description: "Copying the file or recording the document failed. Nothing was stored for the client." },
    PROCESSING_FAILED: { label: "Processing error", description: "Processing stopped with an error." },
    NOT_RECORDED: { label: "Not recorded", description: "This submission was processed before failure details were saved." },
};

export function failureLabel(code: string | undefined | null): string {
    return code ? FAILURE_REASONS[code]?.label ?? humanize(code) : "Processing failed";
}

// Review actions and corrections in the audit log (there is no reject).
export const AUDIT_ACTIONS: Record<string, { label: string; tone: Tone }> = {
    APPROVE: { label: "Approved", tone: "verified" },
    KEEP_PENDING: { label: "Kept pending", tone: "review" },
    REMOVE_FROM_REVIEW: { label: "Removed from review", tone: "critical" },
    SET_DOCUMENT_TYPE: { label: "Document type set", tone: "pending" },
    ASSIGN_CLIENT: { label: "Client assigned", tone: "pending" },
    SET_POLICE_DATE: { label: "Police slip date set", tone: "pending" },
};
