import { Route, Routes } from "react-router";
import { RequireAuth } from "./auth/RequireAuth";
import { AdminLayout } from "./layout/AdminLayout";
import { ClientDetailsPage } from "./pages/ClientDetailsPage";
import { ClientsPage } from "./pages/ClientsPage";
import { DailyReportPage } from "./pages/DailyReportPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { LoginPage } from "./pages/LoginPage";
import { MissingDocumentsPage } from "./pages/MissingDocumentsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PoliceWorkflowPage } from "./pages/PoliceWorkflowPage";
import { ReviewDetailPage } from "./pages/ReviewDetailPage";
import { ReviewQueuePage } from "./pages/ReviewQueuePage";

// Routes are relative to the /admin base (see main.tsx). Overview,
// Documents, Review Queue, Review Detail, Client Details and Police Workflow
// follow their Stitch screens; Clients, Missing Documents and Daily Report
// use the same design language (Stitch has no screen for them).
export function AppRoutes() {
    return (
        <Routes>
            <Route path="/login" element={<LoginPage />} />
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
                <Route path="clients" element={<ClientsPage />} />
                <Route path="clients/:passportId" element={<ClientDetailsPage />} />
                <Route path="missing-documents" element={<MissingDocumentsPage />} />
                <Route path="police" element={<PoliceWorkflowPage />} />
                <Route path="reports/daily" element={<DailyReportPage />} />
                <Route path="*" element={<NotFoundPage />} />
            </Route>
        </Routes>
    );
}
