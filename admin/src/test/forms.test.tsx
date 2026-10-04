import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { HelpTip } from "../components/Form";
import { renderApp, signedInBackend, stubBackend } from "./helpers";

describe("help tip (!)", () => {
    test("opens on hover and closes on mouse leave", async () => {
        render(<HelpTip label="Passport date" text="The date printed on the slip." />);
        const user = userEvent.setup();
        const button = screen.getByRole("button", { name: "About Passport date" });
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

        await user.hover(button);
        expect(screen.getByRole("tooltip")).toHaveTextContent("The date printed on the slip.");
        expect(button).toHaveAccessibleDescription("The date printed on the slip.");
        await user.unhover(button);
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    test("a click/tap opens it (and keeps it open); Escape or a tap elsewhere closes it", async () => {
        render(
            <div>
                <HelpTip label="Email" text="Use your work address." />
                <p>Elsewhere</p>
            </div>
        );
        const user = userEvent.setup();
        await user.pointer({ keys: "[TouchA]", target: screen.getByRole("button", { name: "About Email" }) });
        expect(screen.getByRole("tooltip")).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

        await user.pointer({ keys: "[TouchA]", target: screen.getByRole("button", { name: "About Email" }) });
        expect(screen.getByRole("tooltip")).toBeInTheDocument();
        await user.pointer({ keys: "[TouchA]", target: screen.getByText("Elsewhere") });
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    test("opens on keyboard focus", async () => {
        render(<HelpTip label="Role" text="What each role can do." />);
        await userEvent.setup().tab();
        expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });
});

describe("inline validation", () => {
    const validToken = { "GET /auth/reset-password": { status: 200, body: { valid: true, message: "ok" } } };

    test("reset password: each error sits on its field, nothing is sent, and errors clear once fixed", async () => {
        const { calls } = stubBackend(validToken);
        renderApp("/reset-password?token=valid-token-xyz");
        await screen.findByRole("heading", { name: "Set New Password" });
        const user = userEvent.setup();
        const password = screen.getByLabelText("New Password");
        const confirm = screen.getByLabelText("Confirm Password");

        await user.type(password, "short");
        await user.click(screen.getByRole("button", { name: "Reset password" }));
        expect(password).toHaveAccessibleDescription("Password must be at least 8 characters long.");
        expect(password).toHaveAttribute("aria-invalid", "true");
        expect(confirm).toHaveAccessibleDescription("Enter the password again.");
        expect(password).toHaveFocus();
        expect(calls.some((c) => c.method === "POST")).toBe(false);

        await user.type(password, "-but-long-now");
        expect(password).not.toHaveAttribute("aria-invalid");
        await user.type(confirm, "short-but-long-now");
        expect(confirm).not.toHaveAttribute("aria-invalid");
    });

    test("invitations: an invalid email is caught on the field before any request", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/invitations": { status: 200, body: { invitations: [] } } });
        renderApp("/invitations");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Full Name"), "New Colleague");
        await user.type(screen.getByLabelText("Email Address"), "not-an-email");
        await user.click(screen.getByRole("button", { name: /Send Invitation/ }));
        expect(screen.getByLabelText("Email Address")).toHaveAccessibleDescription("Enter a valid email address, like name@example.com.");
        expect(screen.getByLabelText("Full Name")).not.toHaveAttribute("aria-invalid");
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });
});

describe("Candidates screens keep their original look", () => {
    test("candidate routes render inside .ui-classic and mark the page; other pages don't", async () => {
        signedInBackend({ "GET /api/admin/candidates": { status: 200, body: { items: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } } } });
        const { unmount } = renderApp("/candidates");
        const heading = await screen.findByRole("heading", { name: "Candidates", level: 1 });
        expect(heading.closest(".ui-classic")).not.toBeNull();
        expect(document.body).toHaveClass("ui-classic-page");
        unmount();
        expect(document.body).not.toHaveClass("ui-classic-page");

        renderApp("/");
        const overview = await screen.findByRole("heading", { name: "Overview", level: 1 });
        expect(overview.closest(".ui-classic")).toBeNull();
        expect(document.body).not.toHaveClass("ui-classic-page");
    });
});
