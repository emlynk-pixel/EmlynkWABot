import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { listAuditLogs, type AuditCategory, type AuditChange, type AuditLogItem, type AuditLogParams } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { STAGE_LABELS } from "../api/candidates";
import { isAdmin, useAuth } from "../auth/AuthProvider";
import { ROLE_LABELS, type Role } from "../auth/roles";
import { secondaryButton } from "../components/Dialog";
import { documentTypeLabel, formatDateTime, formatDay, formatNumber, humanize } from "../components/format";
import { Icon } from "../components/Icon";
import { AUDIT_ACTIONS as REVIEW_ACTIONS } from "../components/reviewLabels";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/States";
import { ToneBadge, type Tone } from "../components/StatusBadge";
import { fieldLabel, filterControl, tableCell, tableCellWrap, tableHead } from "../components/ui";

// Audit Logs (ADMIN only): who changed what, newest first. View only: there
// is no edit, delete, clear or rollback here or in the API. Filters and the
// page live in the URL, so a filtered view can be reloaded or shared with
// another admin; the server does the filtering and paging.

export const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

const CATEGORY_LABELS: Record<AuditCategory, string> = {
    CANDIDATE: "Candidate",
    STAGE: "Stage",
    DOCUMENT: "Document",
    REVIEW: "Review",
    USER: "User",
    OTHER: "Other",
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as AuditCategory[];

const ACTION_LABELS: Record<string, string> = {
    CREATE_CANDIDATE: "Candidate registered",
    UPDATE_CANDIDATE: "Candidate details updated",
    UPDATE_STAGE: "Stage updated",
    CREATE_ADDITIONAL_DETAILS: "Additional details added",
    UPDATE_ADDITIONAL_DETAILS: "Additional details updated",
    UPLOAD_DOCUMENT: "Document uploaded",
    REMOVE_DOCUMENT: "Document removed",
    DELETE_TEMPORARY_DOCUMENT: "Temporary document deleted",
    INVITE_USER: "User invited",
    REACTIVATE_USER: "User reactivated",
    COMPLETE_INVITATION: "Invitation accepted",
    UPDATE_USER_ROLE: "Role changed",
    DEACTIVATE_USER: "User deactivated",
    ...Object.fromEntries(Object.entries(REVIEW_ACTIONS).map(([action, { label }]) => [action, label])),
};
export const actionLabel = (action: string) => ACTION_LABELS[action] ?? humanize(action);

const CATEGORY_TONES: Record<AuditCategory, Tone> = {
    CANDIDATE: "verified",
    STAGE: "pending",
    DOCUMENT: "review",
    REVIEW: "review",
    USER: "duplicate",
    OTHER: "pending",
};

// Candidate fields as the registration form names them.
const FIELD_LABELS: Record<string, string> = {
    otherName: "Surname",
    firstName: "Other names",
    address: "Address",
    nic: "NIC",
    job: "Job types",
    jobExperience: "Job experience",
    whatsappNumber: "WhatsApp number",
    contactNumber: "Contact number",
    placeOfBirth: "Place of birth",
    dateOfBirth: "Date of birth",
    passportIssueDate: "Passport issue date",
    passportExpiryDate: "Passport expiry date",
    nationality: "Nationality",
    sex: "Sex",
    completed: "Completed",
    notes: "Notes",
    jobId: "Job ID",
    testResult: "Test result",
    testDate: "Test date",
    // Additional details
    nameAsInPassport: "Name according to passport",
    permanentAddress: "Permanent address",
    birthday: "Birthday",
    tshirtSize: "T-shirt size",
    pantSize: "Pant size",
    shoeSize: "Shoe size",
    fatherAlive: "Father alive",
    fatherFullName: "Father full name",
    fatherBirthday: "Father birthday",
    motherAlive: "Mother alive",
    motherFullName: "Mother full name",
    motherBirthday: "Mother birthday",
    maritalStatus: "Marital status",
    wifeFullName: "Wife full name",
    wifeBirthday: "Wife birthday",
    child1Name: "1st child name",
    child2Name: "2nd child name",
    child3Name: "3rd child name",
    otherJobSkills: "Other job skills",
};
const fieldLabelOf = (field: string) => FIELD_LABELS[field] ?? humanize(field);
const stageLabel = (stage: string) => STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? humanize(stage);
const roleLabel = (role: string | null) => (role ? ROLE_LABELS[role as Role] ?? humanize(role) : "—");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function paramsFrom(search: URLSearchParams): AuditLogParams {
    const page = Number(search.get("page"));
    const pageSize = Number(search.get("pageSize"));
    const category = search.get("category") as AuditCategory | null;
    const date = (name: string) => {
        const value = search.get(name);
        return value && DATE_PATTERN.test(value) ? value : undefined;
    };
    return {
        page: Number.isInteger(page) && page > 0 ? page : 1,
        pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
        adminId: search.get("adminId") || undefined,
        passportId: search.get("passportId") || undefined,
        candidate: search.get("candidate") || undefined,
        action: search.get("action") || undefined,
        category: category && CATEGORIES.includes(category) ? category : undefined,
        startDate: date("startDate"),
        endDate: date("endDate"),
        search: search.get("search") || undefined,
    };
}

const FILTER_NAMES = ["adminId", "passportId", "candidate", "action", "category", "startDate", "endDate", "search"] as const;

export function AuditLogsPage() {
    const { user } = useAuth();
    if (!isAdmin(user)) {
        return (
            <div className="mx-auto max-w-4xl p-6">
                <div role="alert" className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                    <Icon name="lock" className="mx-auto mb-2 size-8 text-critical" />
                    <h1 className="text-headline-sm font-semibold">Access Restricted</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">
                        Only users with the <strong>Admin</strong> role can view the audit logs.
                    </p>
                </div>
            </div>
        );
    }
    return <AuditLogsView />;
}

function AuditLogsView() {
    const [searchParams, setSearchParams] = useSearchParams();
    const params = paramsFrom(searchParams);
    const key = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    const list = useAdminResource(`audit-logs?${key}`, (token, signal) => listAuditLogs(token, params, signal));
    const data = list.data;

    const update = (changes: Record<string, string | undefined>, { keepPage = false } = {}) => {
        const next = new URLSearchParams(searchParams);
        for (const [name, value] of Object.entries(changes)) {
            if (value) next.set(name, value);
            else next.delete(name);
        }
        if (!keepPage) next.delete("page");
        setSearchParams(next);
    };

    // Text filters apply on "Apply" (or Enter), not on every keystroke.
    const [candidateText, setCandidateText] = useState(params.candidate ?? "");
    const [searchText, setSearchText] = useState(params.search ?? "");
    useEffect(() => setCandidateText(params.candidate ?? ""), [params.candidate]);
    useEffect(() => setSearchText(params.search ?? ""), [params.search]);
    const applyText = (event: FormEvent) => {
        event.preventDefault();
        update({ candidate: candidateText.trim() || undefined, search: searchText.trim() || undefined });
    };

    const filtered = FILTER_NAMES.some((name) => params[name] !== undefined);
    const clearFilters = () => {
        const next = new URLSearchParams();
        if (params.pageSize !== DEFAULT_PAGE_SIZE) next.set("pageSize", String(params.pageSize));
        setSearchParams(next);
    };

    // Actions offered: those of the chosen category, or all.
    const actions = params.category
        ? data?.filters.categories.find((c) => c.category === params.category)?.actions ?? []
        : data?.filters.actions ?? [];
    const users = data?.filters.users ?? [];

    return (
        <section aria-labelledby="page-title" className="space-y-4">
            <div>
                <h1 id="page-title" className="text-headline-lg text-ink">Audit Logs</h1>
                <p className="mt-1 text-body-sm text-ink-muted">
                    Every recorded change to candidates, stages, documents, reviews and users, newest first. Entries are permanent and can't be edited or removed.
                </p>
            </div>

            <Card className="p-5">
                <form role="search" aria-label="Filter audit logs" onSubmit={applyText} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <FilterField label="Performed by" htmlFor="audit-user">
                        <select id="audit-user" value={params.adminId ?? ""} onChange={(e) => update({ adminId: e.target.value || undefined })} className={filterControl}>
                            <option value="">All users</option>
                            {params.adminId && !users.some((u) => u.userId === params.adminId) && <option value={params.adminId}>{params.adminId}</option>}
                            {users.map((u) => (
                                <option key={u.userId} value={u.userId}>{u.name} ({roleLabel(u.role)}){u.status !== "ACTIVE" ? ` · ${humanize(u.status)}` : ""}</option>
                            ))}
                        </select>
                    </FilterField>
                    <FilterField label="Candidate" htmlFor="audit-candidate">
                        <input
                            id="audit-candidate"
                            type="search"
                            value={candidateText}
                            maxLength={100}
                            onChange={(e) => setCandidateText(e.target.value)}
                            placeholder="Passport ID, unique ID or name"
                            className={filterControl}
                        />
                    </FilterField>
                    <FilterField label="Category" htmlFor="audit-category">
                        <select id="audit-category" value={params.category ?? ""} onChange={(e) => update({ category: e.target.value || undefined, action: undefined })} className={filterControl}>
                            <option value="">All categories</option>
                            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                        </select>
                    </FilterField>
                    <FilterField label="Action" htmlFor="audit-action">
                        <select id="audit-action" value={params.action ?? ""} onChange={(e) => update({ action: e.target.value || undefined })} className={filterControl}>
                            <option value="">All actions</option>
                            {params.action && !actions.includes(params.action) && <option value={params.action}>{actionLabel(params.action)}</option>}
                            {actions.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
                        </select>
                    </FilterField>
                    <FilterField label="From" htmlFor="audit-start">
                        <input id="audit-start" type="date" value={params.startDate ?? ""} max={params.endDate} onChange={(e) => update({ startDate: e.target.value || undefined })} className={filterControl} />
                    </FilterField>
                    <FilterField label="To" htmlFor="audit-end">
                        <input id="audit-end" type="date" value={params.endDate ?? ""} min={params.startDate} onChange={(e) => update({ endDate: e.target.value || undefined })} className={filterControl} />
                    </FilterField>
                    <FilterField label="Search" htmlFor="audit-search">
                        <input
                            id="audit-search"
                            type="search"
                            value={searchText}
                            maxLength={100}
                            onChange={(e) => setSearchText(e.target.value)}
                            placeholder="Reason, value, status or user"
                            className={filterControl}
                        />
                    </FilterField>
                    <div className="flex items-end gap-2">
                        <button type="submit" className="h-10 rounded-md bg-primary px-4 text-label-md text-on-primary hover:opacity-90">Apply</button>
                        <button type="button" onClick={clearFilters} disabled={!filtered} className={secondaryButton.replace("h-9", "h-10")}>Clear filters</button>
                    </div>
                </form>
                {params.passportId && (
                    <p className="mt-3 flex flex-wrap items-center gap-2 text-body-sm text-ink-muted">
                        Passport ID <span className="font-medium text-ink">{params.passportId}</span>
                        <button type="button" onClick={() => update({ passportId: undefined })} className="text-label-md text-primary hover:underline">Remove</button>
                    </p>
                )}
            </Card>

            <Card>
                {list.status === "error" && <ErrorState message={list.error.message} onRetry={list.reload} />}
                {list.status === "loading" && <LoadingState label="Loading audit logs…" />}
                {list.status === "success" && data && data.items.length === 0 && (
                    <EmptyState
                        title={filtered ? "No entries match these filters" : "No audit entries yet"}
                        description={filtered ? "Try a wider date range or fewer filters." : "Changes made in the admin dashboard will appear here."}
                        action={filtered ? <button type="button" onClick={clearFilters} className="text-label-md text-primary hover:underline">Clear filters</button> : undefined}
                    />
                )}
                {list.status === "success" && data && data.items.length > 0 && (
                    <>
                        <div className="overflow-x-auto">
                            <table className="w-full border-separate border-spacing-0">
                                <caption className="sr-only">Audit log entries</caption>
                                <thead>
                                    <tr>
                                        {["Date / time", "Action", "Performed by", "Candidate", "Category", "Change", "Reason / notes"].map((h) => (
                                            <th key={h} scope="col" className={tableHead}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.items.map((item) => <AuditRow key={item.auditId} item={item} />)}
                                </tbody>
                            </table>
                        </div>
                        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-body-sm text-ink-muted">
                            <p>{formatNumber(data.pagination.total)} {data.pagination.total === 1 ? "entry" : "entries"}</p>
                            <div className="flex flex-wrap items-center gap-2">
                                <label htmlFor="audit-page-size" className="text-label-md text-ink">Rows</label>
                                <select id="audit-page-size" value={params.pageSize} onChange={(e) => update({ pageSize: e.target.value })} className={`${filterControl} h-8 w-20`}>
                                    {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                                </select>
                                <button type="button" disabled={data.pagination.page <= 1} onClick={() => update({ page: String(data.pagination.page - 1) }, { keepPage: true })} className="h-8 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft disabled:opacity-50">Previous</button>
                                <span aria-current="page">Page {data.pagination.page} of {data.pagination.totalPages}</span>
                                <button type="button" disabled={data.pagination.page >= data.pagination.totalPages} onClick={() => update({ page: String(data.pagination.page + 1) }, { keepPage: true })} className="h-8 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft disabled:opacity-50">Next</button>
                            </div>
                        </nav>
                    </>
                )}
            </Card>
        </section>
    );
}

function FilterField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={htmlFor} className={fieldLabel}>{label}</label>
            {children}
        </div>
    );
}

// Long text (an address, a note) wraps and is cut to a few lines; the whole
// value is in the tooltip.
const clamp = "line-clamp-3 [overflow-wrap:anywhere]";

function displayValue(field: string, value: AuditChange["from"]): string {
    if (value === null || value === "") return "—";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (/(Date|[bB]irthday)$/.test(field) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDay(value);
    if (field === "testResult") return humanize(value);
    return value;
}

function ChangeList({ changes }: { changes: AuditChange[] }) {
    return (
        <ul className="space-y-1">
            {changes.map(({ field, from, to }) => {
                const before = displayValue(field, from);
                const after = displayValue(field, to);
                return (
                    <li key={field} className="min-w-0" title={`${fieldLabelOf(field)}: ${before} → ${after}`}>
                        <span className="text-label-sm text-ink-subtle">{fieldLabelOf(field)}</span>
                        <span className={`block ${clamp}`}>
                            <span className="text-ink-muted line-through decoration-ink-subtle">{before}</span>
                            <span aria-hidden="true" className="px-1 text-ink-subtle">→</span>
                            <span className="sr-only"> changed to </span>
                            <span className="text-ink">{after}</span>
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

// Old → new: the values when both are recorded (e.g. a role), otherwise the
// statuses, with a lone new value (e.g. the account concerned) underneath.
function StatusChange({ item }: { item: AuditLogItem }) {
    const values = item.previousValue !== null && item.newValue !== null;
    const from = values ? item.previousValue as string : humanize(item.previousStatus);
    const to = values ? item.newValue as string : humanize(item.newStatus);
    const extra = !values ? item.newValue ?? item.previousValue : null;
    return (
        <>
            <span className={`block ${clamp}`} title={`${from} → ${to}`}>
                <span className="text-ink-muted">{from}</span>
                <span aria-hidden="true" className="px-1 text-ink-subtle">→</span>
                <span className="sr-only"> changed to </span>
                <span className="text-ink">{to}</span>
            </span>
            {extra && <span className={`block text-label-sm text-ink-subtle ${clamp}`} title={extra}>{extra}</span>}
        </>
    );
}

function AuditRow({ item }: { item: AuditLogItem }) {
    const td = tableCell;
    const wrap = `${tableCellWrap} align-top`;
    // A detail update names its fields in the reason; the Change column already shows them.
    const reason = item.action === "UPDATE_CANDIDATE" ? null : item.reason;
    const subject = item.stage ? stageLabel(item.stage) : item.documentType ? documentTypeLabel(item.documentType) : null;
    return (
        <tr className="hover:bg-canvas" data-testid="audit-row">
            <td className={`${td} align-top tabular-nums text-ink-soft`}>{formatDateTime(item.createdDate)}</td>
            <td className={`${wrap} min-w-[10rem]`}>
                <span className="font-medium text-ink">{actionLabel(item.action)}</span>
                {subject && <span className="block text-label-sm text-ink-subtle">{subject}</span>}
            </td>
            <td className={`${wrap} min-w-[9rem]`}>
                <span className={`block text-ink ${clamp}`}>{item.actor.name ?? "Unknown user"}</span>
                <span className="block text-label-sm text-ink-subtle">{roleLabel(item.actor.role)}</span>
            </td>
            <td className={`${wrap} min-w-[9rem]`}>
                {item.candidate ? (
                    <>
                        <Link to={`/candidates/${encodeURIComponent(item.candidate.passportId)}`} className={`block font-medium text-primary hover:underline ${clamp}`}>
                            {item.candidate.name ?? item.candidate.passportId}
                        </Link>
                        <span className="block text-label-sm text-ink-subtle">
                            {item.candidate.passportId}{item.candidate.uniqueId ? ` · ${item.candidate.uniqueId}` : ""}
                        </span>
                    </>
                ) : (
                    <span className="text-ink-subtle">—</span>
                )}
            </td>
            <td className={`${td} align-top`}><ToneBadge tone={CATEGORY_TONES[item.category] ?? "pending"}>{CATEGORY_LABELS[item.category] ?? humanize(item.category)}</ToneBadge></td>
            <td className={`${wrap} min-w-[14rem] max-w-[22rem]`}>
                {item.changes && item.changes.length > 0 ? <ChangeList changes={item.changes} /> : <StatusChange item={item} />}
                {item.policeSubmittedDate && <span className="block text-label-sm text-ink-subtle">Slip date {formatDay(item.policeSubmittedDate)}</span>}
            </td>
            <td className={`${wrap} min-w-[12rem] max-w-[20rem]`}>
                {reason ? <span className={`block text-ink-soft ${clamp}`} title={reason}>{reason}</span> : <span className="text-ink-subtle">—</span>}
            </td>
        </tr>
    );
}
