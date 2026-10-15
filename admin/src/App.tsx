import { useEffect } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router";
import { canViewDashboard, useAuth } from "./auth/AuthProvider";
import { RequireAuth } from "./auth/RequireAuth";
import { AdminLayout } from "./layout/AdminLayout";
import { CandidateDeploymentPage } from "./pages/CandidateDeploymentPage";
import { CandidateRegistrationPage } from "./pages/CandidateRegistrationPage";
import { CandidatesPage } from "./pages/CandidatesPage";
import { ClientDetailsPage } from "./pages/ClientDetailsPage";
import { ClientsPage } from "./pages/ClientsPage";
import { DailyReportPage } from "./pages/DailyReportPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
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

// The landing page: the Overview, or Candidates for a role without dashboard
// access (REGISTRATION_DESK), which the API would otherwise refuse.
function HomePage() {
    const { user } = useAuth();
    return canViewDashboard(user) ? <OverviewPage /> : <Navigate to="/candidates" replace />;
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
                <Route path="documents" element={<DocumentsPage />} />
                <Route path="review" element={<ReviewQueuePage />} />
                <Route path="review/:id" element={<ReviewDetailPage />} />
                <Route element={<ClassicArea />}>
                    <Route path="candidates" element={<CandidatesPage />} />
                    <Route path="candidates/new" element={<CandidateRegistrationPage />} />
                    <Route path="candidates/:passportId" element={<CandidateDeploymentPage />} />
                </Route>
                {/* No longer in the sidebar (Candidates replaces it); kept for the
                    Overview completeness links and the client-details breadcrumb. */}
                <Route path="clients" element={<ClientsPage />} />
                <Route path="clients/:passportId" element={<ClientDetailsPage />} />
                <Route path="missing-documents" element={<MissingDocumentsPage />} />
                <Route path="police" element={<PoliceWorkflowPage />} />
                <Route path="follow-ups" element={<PriorityFollowUpsPage />} />
                <Route path="work-allocation" element={<WorkAllocationPage />} />
                <Route path="reports/daily" element={<DailyReportPage />} />
                {/* Invite User and Change Roles are Settings tabs; the old URLs
                    (bookmarks, links) open the matching tab. */}
                <Route path="invitations" element={<Navigate to="/settings/invite" replace />} />
                <Route path="roles" element={<Navigate to="/settings/roles" replace />} />
                <Route path="audit-logs" element={<AuditLogsPage />} />
                <Route path="settings" element={<SettingsPage />}>
                    {/* Settings opens its first tab. Every tab is ADMIN only, like
                        Settings itself, so the first one is always allowed. */}
                    <Route index element={<Navigate to="/settings/roles" replace />} />
                    <Route path="roles" element={<AdminRolesPage embedded />} />
                    <Route path="invite" element={<InvitationsPage embedded />} />
                    <Route path="sheet-sync" element={<SheetSyncSettings />} />
                </Route>
                <Route path="*" element={<NotFoundPage />} />
            </Route>
        </Routes>
    );
}
