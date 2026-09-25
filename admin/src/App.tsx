import { Route, Routes } from "react-router";
import { RequireAuth } from "./auth/RequireAuth";
import { AdminLayout } from "./layout/AdminLayout";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
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
                <Route path="documents" element={<SectionPlaceholder title="Documents" description="All stored client documents, their status and verification." />} />
                <Route path="review" element={<SectionPlaceholder title="Review Queue" description="Documents waiting for an administrator's decision." />} />
                <Route path="clients" element={<SectionPlaceholder title="Clients" description="Client profiles and their submitted documents." />} />
                <Route path="police" element={<SectionPlaceholder title="Police Workflow" description="Police slips, final reports and the 21-day follow-up." />} />
                <Route path="*" element={<NotFoundPage />} />
            </Route>
        </Routes>
    );
}
