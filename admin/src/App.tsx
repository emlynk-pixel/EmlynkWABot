import { Navigate, Outlet, Route, Routes } from "react-router";
import { useAuth } from "./auth/AuthProvider";
import { CANDIDATE_LIST_ROLES, CANDIDATE_VIEW_ROLES, DASHBOARD_ROLES, FOLLOW_UP_VIEW_ROLES, REPORT_VIEW_ROLES, hasRole, landingPath, type Role } from "./auth/roles";
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
import { SettingsIndex, SettingsPage, SettingsTab, SheetSyncSettings } from "./pages/SettingsPage";
import { ADMIN_ONLY } from "./auth/roles";
import { FormBrandingSettings } from "./pages/FormBrandingSettings";
import { JobTypesSettings } from "./pages/JobTypesSettings";
import { SetupPasswordPage } from "./pages/SetupPasswordPage";
import { WorkAllocationPage } from "./pages/WorkAllocationPage";

// The landing page: the Overview, or for a role without dashboard access (which
// the API would otherwise refuse) its own first area (roles.ts landingPath):
// Jobs for JOB_HANDLER, Add Candidate for REGISTRATION_DESK, Candidates for TEAM_LEAD.
function HomePage() {
    const { user } = useAuth();
    const to = landingPath(user);
    return to ? <Navigate to={to} replace /> : <OverviewPage />;
}

// Pages whose own component has no role check open only to the listed roles (the same
// lists as the sidebar, layout/navigation.ts). Anyone else opening one by URL sees
// "Access Restricted" and nothing is requested (the API refuses them either way). An
// allow-list: a role not named, a new one included, is refused by default.
function AllowRoles({ roles }: { roles: readonly Role[] }) {
    const { user } = useAuth();
    if (hasRole(user, roles)) return <Outlet />;
    return (
        <div className="mx-auto max-w-4xl p-6">
            <div role="alert" className="rounded-lg border border-critical-border bg-critical-bg p-6 text-center text-critical">
                <h1 className="text-headline-sm font-semibold">Access Restricted</h1>
                <p className="mt-1 text-body-sm text-ink-muted">Your role cannot open this page.</p>
            </div>
        </div>
    );
}

// Routes are relative to the /admin base (see main.tsx). Overview,
// Documents, Review Queue, Review Detail, Client Details, Police Workflow,
// Clients, Missing Documents and Daily Report.
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
                <Route element={<AllowRoles roles={DASHBOARD_ROLES} />}>
                    <Route path="documents" element={<DocumentsPage />} />
                    <Route path="review" element={<ReviewQueuePage />} />
                    <Route path="review/:id" element={<ReviewDetailPage />} />
                    {/* No longer in the sidebar (Candidates replaces it); kept for the
                        Overview completeness links and the client-details breadcrumb. */}
                    <Route path="clients" element={<ClientsPage />} />
                    <Route path="clients/:passportId" element={<ClientDetailsPage />} />
                    <Route path="missing-documents" element={<MissingDocumentsPage />} />
                    <Route path="police" element={<PoliceWorkflowPage />} />
                </Route>
                <Route element={<AllowRoles roles={REPORT_VIEW_ROLES} />}>
                    <Route path="reports/daily" element={<DailyReportPage />} />
                </Route>
                <Route element={<AllowRoles roles={CANDIDATE_LIST_ROLES} />}>
                    <Route path="candidates" element={<CandidatesPage />} />
                </Route>
                {/* The page checks the registration roles itself (with its own explanation). */}
                <Route path="candidates/new" element={<CandidateRegistrationPage />} />
                {/* JOB_HANDLER opens it read only (canManageCandidates decides every change); not REGISTRATION_DESK. */}
                <Route element={<AllowRoles roles={CANDIDATE_VIEW_ROLES} />}>
                    <Route path="candidates/:passportId" element={<CandidateDeploymentPage />} />
                </Route>
                <Route element={<AllowRoles roles={FOLLOW_UP_VIEW_ROLES} />}>
                    <Route path="follow-ups" element={<PriorityFollowUpsPage />} />
                </Route>
                {/* These pages check their own roles (the same lists as the sidebar). */}
                <Route path="jobs" element={<JobsPage />} />
                <Route path="jobs/:jobId" element={<JobDetailsPage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:agentId" element={<AgentDetailsPage />} />
                <Route path="client-management" element={<ClientManagementPage />} />
                <Route path="client-management/:clientId" element={<ClientManagementDetailsPage />} />
                <Route path="work-allocation" element={<WorkAllocationPage />} />
                {/* Invite User and Change Roles are Settings tabs; the old URLs
                    (bookmarks, links) open the matching tab (ADMIN only, like Settings). */}
                <Route path="invitations" element={<Navigate to="/settings/invite" replace />} />
                <Route path="roles" element={<Navigate to="/settings/roles" replace />} />
                <Route path="audit-logs" element={<AuditLogsPage />} />
                <Route path="settings" element={<SettingsPage />}>
                    {/* Settings opens the first tab the user may open (layout/navigation.ts SETTINGS_TABS). */}
                    <Route index element={<SettingsIndex />} />
                    <Route path="roles" element={<SettingsTab roles={ADMIN_ONLY}><AdminRolesPage embedded /></SettingsTab>} />
                    <Route path="invite" element={<SettingsTab roles={ADMIN_ONLY}><InvitationsPage embedded /></SettingsTab>} />
                    <Route path="sheet-sync" element={<SheetSyncSettings />} />
                    <Route path="job-types" element={<SettingsTab roles={ADMIN_ONLY}><JobTypesSettings /></SettingsTab>} />
                    <Route path="candidate-form" element={<SettingsTab roles={ADMIN_ONLY}><FormBrandingSettings /></SettingsTab>} />
                </Route>
                <Route path="*" element={<NotFoundPage />} />
            </Route>
        </Routes>
    );
}
