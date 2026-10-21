import { useEffect, useRef } from "react";
import { AdminContactNumbers } from "../components/ContactAdmin";
import { adminMobileNumbers } from "../config/env";
import { translate, type MessageKey } from "../i18n/translations";

// "Before you start": how the form works, shown once the candidate is
// verified and their form has loaded, before the first editable step. English
// and Sinhala are shown together, so nobody has to switch language to read
// the rules. "I Understand – Continue" is a UX acknowledgement only: it is
// kept nowhere (a reload asks for the link again, as before) and guards
// nothing; the link, the session and the submission lock stay on the server.

const RULES: readonly MessageKey[] = [
    "guidelines.rule.accurate",
    "guidelines.rule.required",
    "guidelines.rule.na",
    "guidelines.rule.review",
    "guidelines.rule.personal",
    "guidelines.rule.locked",
];

// One instruction in both languages, English first.
function Both({ k, as: Tag = "p", className }: { k: MessageKey; as?: "p" | "span"; className?: string }) {
    return (
        <>
            <Tag lang="en" className={className}>{translate("en", k)}</Tag>
            <Tag lang="si" className={className ? `${className} si` : "si"}>{translate("si", k)}</Tag>
        </>
    );
}

export function GuidelinesPage({ onContinue }: { onContinue: () => void }) {
    const heading = useRef<HTMLHeadingElement>(null);
    const numbers = adminMobileNumbers();
    // Screen readers and keyboards start at the page heading.
    useEffect(() => heading.current?.focus(), []);

    return (
        <section className="panel guidelines" aria-labelledby="guidelines-title">
            <h1 id="guidelines-title" ref={heading} tabIndex={-1}>
                <span lang="en">{translate("en", "guidelines.title")}</span>
                <span lang="si" className="guidelines-title-si">{translate("si", "guidelines.title")}</span>
            </h1>
            <div className="guidelines-intro">
                <Both k="guidelines.intro" />
            </div>

            <ol className="guidelines-list">
                {RULES.map((rule) => (
                    <li key={rule}>
                        <Both k={rule} />
                    </li>
                ))}
                <li>
                    <Both k={numbers.length > 0 ? "guidelines.rule.helpNumbers" : "guidelines.rule.help"} />
                </li>
            </ol>

            {/* The one-time rule, said plainly: a heading word, not colour alone. */}
            <div className="guidelines-warning" role="note">
                <p className="guidelines-warning-title"><span aria-hidden="true">! </span><Both k="guidelines.warning.title" as="span" /></p>
                <Both k="guidelines.warning.text" />
            </div>

            <AdminContactNumbers
                numbers={numbers}
                heading={<><span lang="en">{translate("en", "guidelines.numbers")}</span> / <span lang="si">{translate("si", "guidelines.numbers")}</span></>}
            />

            <button type="button" className="primary guidelines-continue" onClick={onContinue}>
                <span lang="en">{translate("en", "guidelines.continue")}</span>
                <span lang="si" className="guidelines-continue-si">{translate("si", "guidelines.continue")}</span>
            </button>
        </section>
    );
}
