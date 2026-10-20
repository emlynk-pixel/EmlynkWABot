import { adminMobileNumbers } from "../config/env";
import { translate } from "../i18n/translations";

// "We couldn't continue with this form link": the same fixed text for every
// access failure, in English AND Sinhala together, displaying configured admin mobile numbers.
// It never says why (no passport, NIC, job or link detail).

export function ContactAdmin({ compact = false }: { compact?: boolean }) {
    const numbers = adminMobileNumbers();
    const Title = compact ? "p" : "h1";
    return (
        <div className={compact ? "contact-admin contact-compact" : "contact-admin"}>
            <div lang="en">
                <Title className="contact-title">{translate("en", "contact.title")}</Title>
                <p className="contact-text">{translate("en", "contact.text")}</p>
            </div>
            <div lang="si">
                <p className="contact-title">{translate("si", "contact.title")}</p>
                <p className="contact-text">{translate("si", "contact.text")}</p>
            </div>
            <AdminContactNumbers numbers={numbers} heading="Admin Contact Numbers" />
        </div>
    );
}

// The configured admin numbers (VITE_API_ADMIN_MOBILE_NUMBERS), shown as plain
// text: no call or WhatsApp link. Nothing at all when none are configured.
export function AdminContactNumbers({ numbers, heading }: { numbers: readonly string[]; heading: React.ReactNode }) {
    if (numbers.length === 0) return null;
    return (
        <div className="contact-numbers">
            <p className="contact-numbers-heading">{heading}</p>
            <div className="contact-numbers-list">
                {numbers.map((number, idx) => (
                    <p key={`${number}-${idx}`} className="contact-number">{number}</p>
                ))}
            </div>
        </div>
    );
}

// The full screen, for the permanent states (already submitted, and any other
// case where retrying the same details cannot help).
export function ContactAdminScreen() {
    return (
        <section className="panel status-panel status-error" role="alert">
            <p className="status-icon status-icon-warning" aria-hidden="true">!</p>
            <ContactAdmin />
        </section>
    );
}
