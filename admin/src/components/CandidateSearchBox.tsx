import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { getCandidateSuggestions, SUGGESTION_MIN_LENGTH, type CandidateSuggestion } from "../api/candidates";
import { useAuth } from "../auth/AuthProvider";

// The candidate quick-search box with live suggestions (an ARIA combobox). While the user types
// (2+ characters, 250 ms after the last key, the previous request aborted) the server suggests a
// few candidates from the user's own scope (and Work Allocation's view). Picking one (click, or
// Arrow keys + Enter) puts its name in the box and runs the page's normal search; Enter with no
// suggestion highlighted submits the form as before; Escape closes the list. Nothing is filtered
// in the browser: the list itself still comes from the list endpoint.

export const SUGGESTION_DEBOUNCE_MS = 250;
const inputClass = "h-8 w-full rounded-lg border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none";

export function CandidateSearchBox({ id, value, onChange, onPick, placeholder, allocation }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    // A suggestion was chosen: search for this text.
    onPick: (text: string) => void;
    placeholder: string;
    allocation?: "ALLOCATED" | "UNALLOCATED";
}) {
    const { token } = useAuth();
    const listId = useId();
    const [items, setItems] = useState<CandidateSuggestion[]>([]);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    // Only what the user typed asks for suggestions (not a value put in the box by the page).
    const [typed, setTyped] = useState<string | null>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        const q = typed?.trim() ?? "";
        if (!token || q.length < SUGGESTION_MIN_LENGTH) {
            setItems([]);
            setOpen(false);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            getCandidateSuggestions(token, q, { allocation }, controller.signal)
                .then((result) => {
                    setItems(result.items);
                    setActive(-1);
                    setOpen(true);
                })
                .catch(() => {
                    // Suggestions are a convenience: on any failure the box works as a plain search.
                    if (!controller.signal.aborted) setOpen(false);
                });
        }, SUGGESTION_DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [typed, token, allocation]);
    useEffect(() => () => clearTimeout(closeTimer.current), []);

    const close = () => {
        setOpen(false);
        setActive(-1);
        setTyped(null);
    };
    const pick = (item: CandidateSuggestion) => {
        const text = item.name ?? item.passportId;
        close();
        onChange(text);
        onPick(text);
    };
    const showing = open && items.length > 0;
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (!showing) {
            // Enter submits the form (a plain search); a pending suggestion request is dropped.
            if (event.key === "Enter") setTyped(null);
            return;
        }
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => (index + 1) % items.length);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => (index <= 0 ? items.length - 1 : index - 1));
        } else if (event.key === "Enter") {
            if (active >= 0) {
                event.preventDefault();
                pick(items[active]);
            } else close();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    };
    const optionId = (index: number) => `${listId}-option-${index}`;

    return (
        <div className="relative min-w-0 flex-1">
            <input
                id={id}
                type="search"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={showing}
                aria-controls={listId}
                aria-activedescendant={showing && active >= 0 ? optionId(active) : undefined}
                autoComplete="off"
                value={value}
                maxLength={100}
                onChange={(event) => {
                    onChange(event.target.value);
                    setTyped(event.target.value);
                }}
                onKeyDown={onKeyDown}
                // A click on a suggestion lands after blur; give it a moment before closing.
                onBlur={() => { closeTimer.current = setTimeout(() => setOpen(false), 150); }}
                onFocus={() => clearTimeout(closeTimer.current)}
                placeholder={placeholder}
                className={inputClass}
            />
            <ul
                id={listId}
                role="listbox"
                aria-label="Candidate suggestions"
                hidden={!showing}
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-modal"
            >
                {items.map((item, index) => (
                    <li
                        key={item.passportId}
                        id={optionId(index)}
                        role="option"
                        aria-selected={index === active}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pick(item)}
                        onMouseEnter={() => setActive(index)}
                        className={`cursor-pointer px-3 py-1.5 ${index === active ? "bg-primary-soft" : ""}`}
                    >
                        <span className="block truncate text-body-sm text-ink">{item.name ?? item.passportId}</span>
                        <span className="block truncate text-label-sm text-ink-subtle">
                            {item.passportId}
                            {item.nic && <> · {item.nic}</>}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
