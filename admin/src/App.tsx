import { Route, Routes } from "react-router";
import { RequireAuth } from "./auth/RequireAuth";
import { AdminLayout } from "./layout/AdminLayout";
import { ClientDetailsPage } from "./pages/ClientDetailsPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PoliceWorkflowPage } from "./pages/PoliceWorkflowPage";
import { ReviewDetailPage } from "./pages/ReviewDetailPage";
import { ReviewQueuePage } from "./pages/ReviewQueuePage";
import { SectionPlaceholder } from "./pages/SectionPlaceholder";

// Routes are relative to the /admin base (see main.tsx). Each maps to a
// Stitch screen; data is connected screen by screen in later checkpoints.
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
                <Route path="clients" element={<SectionPlaceholder title="Clients" description="Client profiles and their submitted documents. Open a client from the Documents or Overview page." />} />
                <Route path="clients/:passportId" element={<ClientDetailsPage />} />
                <Route path="police" element={<PoliceWorkflowPage />} />
                <Route path="*" element={<NotFoundPage />} />
            </Route>
        </Routes>
    );
}
