import { Link } from "react-router";

export function NotFoundPage() {
    return (
        <section aria-labelledby="page-title" className="py-16 text-center">
            <h1 id="page-title" className="text-headline-lg text-ink">Page not found</h1>
            <p className="mt-1 text-body-sm text-ink-muted">This page does not exist in the admin console.</p>
            <Link to="/" className="mt-4 inline-flex h-9 items-center rounded bg-primary px-4 text-label-md text-white hover:bg-primary-hover">
                Back to Overview
            </Link>
        </section>
    );
}
