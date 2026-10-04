import { Route, Routes } from "react-router";
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
import { LoginPage } from "./pages/LoginPage";
import { MissingDocumentsPage } from "./pages/MissingDocumentsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PoliceWorkflowPage } from "./pages/PoliceWorkflowPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { ReviewDetailPage } from "./pages/ReviewDetailPage";
import { ReviewQueuePage } from "./pages/ReviewQueuePage";
import { SetupPasswordPage } from "./pages/SetupPasswordPage";

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
                <Route index element={<OverviewPage />} />
                <Route path="documents" element={<DocumentsPage />} />
                <Route path="review" element={<ReviewQueuePage />} />
                <Route path="review/:id" element={<ReviewDetailPage />} />
                <Route path="candidates" element={<CandidatesPage />} />
                <Route path="candidates/new" element={<CandidateRegistrationPage />} />
                <Route path="candidates/:passportId" element={<CandidateDeploymentPage />} />
                {/* No longer in the sidebar (Candidates replaces it); kept for the
                    Overview completeness links and the client-details breadcrumb. */}
                <Route path="clients" element={<ClientsPage />} />
                <Route path="clients/:passportId" element={<ClientDetailsPage />} />
                <Route path="missing-documents" element={<MissingDocumentsPage />} />
                <Route path="police" element={<PoliceWorkflowPage />} />
                <Route path="reports/daily" element={<DailyReportPage />} />
                <Route path="invitations" element={<InvitationsPage />} />
                <Route path="*" element={<NotFoundPage />} />
            </Route>
        </Routes>
    );
}
