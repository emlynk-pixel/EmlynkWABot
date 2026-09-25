import { useAuth } from "../auth/AuthProvider";
import { SectionPlaceholder } from "./SectionPlaceholder";

export function OverviewPage() {
    const { admin } = useAuth();
    return (
        <SectionPlaceholder
            title="Overview"
            description={`Welcome${admin ? `, ${admin.name}` : ""}. Document processing metrics will appear here.`}
        />
    );
}
