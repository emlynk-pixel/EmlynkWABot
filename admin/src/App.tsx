import { useEffect } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router";
import { canViewDashboard, isAdmin, useAuth } from "./auth/AuthProvider";
import { ROLES, hasRole, type Role } from "./auth/roles";

const JOB_HANDLER_ONLY: readonly Role[] = [ROLES.JOB_HANDLER];
import { RequireAuth } from "./auth/RequireAuth";
import { AdminLayout } from "./layout/AdminLayout";
import { CandidateDeploymentPage } from "./pages/CandidateDeploymentPage";
import { CandidateRegistrationPage } from "./pages/CandidateRegistrationPage";
import { CandidatesPage } from "./pages/CandidatesPage";
import { ClientDetailsPage } from "./pages/ClientDetailsPage";
import { AgentDetailsPage } from "./pages/AgentDetailsPage";
import { AgentsPage } from "./pages/AgentsPage";
import { ClientManagementDetailsPage } from "./pages/ClientManagementDetailsPage";
import { ClientManagementPage } from "./pages/ClientManagementPage";
import { ClientsPage } from "./pages/ClientsPage";
import { DailyReportPage } from "./pages/DailyReportPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { JobDetailsPage } from "./pages/JobDetailsPage";
import { JobsPage } from "./pages/JobsPage";
import { InvitationsPage } from "./pages/InvitationsPage";
import { AdminRolesPage } from "./pages/AdminRolesPage";
import { AuditLogsPage } from "./pages/AuditLogsPage";
import { LoginPage } from "./pages/LoginPage";
import { MissingDocumentsPage } from "./pages/MissingDocumentsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PoliceWorkflowPage } from "./pages/PoliceWorkflowPage";
import { PriorityFollowUpsPage } from "./pages/PriorityFollowUpsPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { ReviewDetailPage } from "./pages/ReviewDetailPage";
import { ReviewQueuePage } from "./pages/ReviewQueuePage";
import { SettingsPage, SheetSyncSettings } from "./pages/SettingsPage";
import { JobTypesSettings } from "./pages/JobTypesSettings";
import { SetupPasswordPage } from "./pages/SetupPasswordPage";
import { WorkAllocationPage } from "./pages/WorkAllocationPage";

// The Candidates screens keep their original look; .ui-classic (index.css)
// restores the previous design tokens inside them, and the body class the
// previous page background behind them.
function ClassicArea() {
    useEffect(() => {
        document.body.classList.add("ui-classic-page");
        return () => document.body.classList.remove("ui-classic-page");
    }, []);
    return (
        <div className="ui-classic">
            <Outlet />
        </div>
    );
}

// The landing page: the Overview, or for a role without dashboard access (which
// the API would otherwise refuse) its own first area: Jobs for JOB_HANDLER,
// Candidates for REGISTRATION_DESK.
function HomePage() {
    const { user } = useAuth();
    if (canViewDashboard(user)) return <OverviewPage />;
    return <Navigate to={hasRole(user, [ROLES.JOB_HANDLER]) ? "/jobs" : "/candidates"} replace />;
}

// Pages outside the Job Handler's modules whose own component has no role check: opened
// by URL by a JOB_HANDLER they show "Access Restricted" instead of loading (the API refuses
// them either way). Only the listed roles are stopped, so every other role sees these pages
// exactly as before.
function DenyRoles({ roles }: { roles: readonly Role[] }) {
    const { user } = useAuth();
    if (!hasRole(user, roles)) return <Outlet />;
    return (
        <div className="mx-auto max-w-4xl p-6">
            <div role="alert" className="rounded border border-critical-border bg-critical-bg p-6 text-center text-critical">
                <h1 className="text-headline-sm font-semibold">Access Restricted</h1>
                <p className="mt-1 text-body-sm text-ink-muted">Your role cannot open this page.</p>
            </div>
        </div>
    );
}

// /invitations: an ADMIN invites from Settings > Invite User (the old URL opens that tab); a
// MANAGER, who has no Settings, invites Job Handlers here; anyone else gets the page's own
// "Access Restricted".
function InvitationsRoute() {
    const { user } = useAuth();
    return isAdmin(user) ? <Navigate to="/settings/invite" replace /> : <InvitationsPage />;
}

// Routes are relative to the /admin base (see main.tsx). Overview,
// Documents, Review Queue, Review Detail, Client Details and Police Workflow
// follow their Stitch screens; Clients, Missing Documents and Daily Report
// use the same design language (Stitch has no screen for them).
export function AppRoutes() {
    return (
        <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/setup-password" element={<SetupPasswordPage />} />
            <Route
                element={
                    <RequireAuth>
                        <AdminLayout />
                    </RequireAuth>
                }
            >
                <Route index element={<HomePage />} />
                <Route element={<DenyRoles roles={JOB_HANDLER_ONLY} />}>
                    <Route path="documents" element={<DocumentsPage />} />
                    <Route path="review" element={<ReviewQueuePage />} />
                    <Route path="review/:id" element={<ReviewDetailPage />} />
                    {/* No longer in the sidebar (Candidates replaces it); kept for the
                        Overview completeness links and the client-details breadcrumb. */}
                    <Route path="clients" element={<ClientsPage />} />
                    <Route path="clients/:passportId" element={<ClientDetailsPage />} />
                    <Route path="missing-documents" element={<MissingDocumentsPage />} />
                    <Route path="police" element={<PoliceWorkflowPage />} />
                    <Route path="reports/daily" element={<DailyReportPage />} />
                </Route>
                <Route element={<ClassicArea />}>
                    {/* A JOB_HANDLER opens Candidates read only (canManageCandidates decides every change). */}
                    <Route path="candidates" element={<CandidatesPage />} />
                    <Route path="candidates/new" element={<CandidateRegistrationPage />} />
                    <Route path="candidates/:passportId" element={<CandidateDeploymentPage />} />
                </Route>
                <Route element={<DenyRoles roles={JOB_HANDLER_ONLY} />}>
                    <Route path="follow-ups" element={<PriorityFollowUpsPage />} />
                </Route>
                <Route path="jobs" element={<JobsPage />} />
                <Route path="jobs/:jobId" element={<JobDetailsPage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:agentId" element={<AgentDetailsPage />} />
                <Route path="client-management" element={<ClientManagementPage />} />
                <Route path="client-management/:clientId" element={<ClientManagementDetailsPage />} />
                <Route path="work-allocation" element={<WorkAllocationPage />} />
                {/* Invite User and Change Roles are Settings tabs; the old URLs
                    (bookmarks, links) open the matching tab. /invitations is also
                    the MANAGER's Job Handler invitation page. */}
                <Route path="invitations" element={<InvitationsRoute />} />
                <Route path="roles" element={<Navigate to="/settings/roles" replace />} />
                <Route path="audit-logs" element={<AuditLogsPage />} />
                <Route path="settings" element={<SettingsPage />}>
                    {/* Settings opens its first tab. Every tab is ADMIN only, like
                        Settings itself, so the first one is always allowed. */}
                    <Route index element={<Navigate to="/settings/roles" replace />} />
                    <Route path="roles" element={<AdminRolesPage embedded />} />
                    <Route path="invite" element={<InvitationsPage embedded />} />
                    <Route path="sheet-sync" element={<SheetSyncSettings />} />
                    <Route path="job-types" element={<JobTypesSettings />} />
                </Route>
                <Route path="*" element={<NotFoundPage />} />
            </Route>
        </Routes>
    );
}
