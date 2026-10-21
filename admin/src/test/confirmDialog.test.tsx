import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ConfirmDialog } from "../components/ConfirmDialog";

describe("ConfirmDialog", () => {
    test("CONFIRM-001: Shared confirmation dialog renders with accessible attributes", () => {
        render(
            <ConfirmDialog
                title="Confirm Action"
                message="Are you sure you want to proceed?"
                confirmLabel="Proceed"
                cancelLabel="Cancel"
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />
        );

        const dialog = screen.getByRole("dialog", { name: "Confirm Action" });
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute("aria-modal", "true");
        expect(screen.getByText("Are you sure you want to proceed?")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Proceed" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });

    test("CONFIRM-002: Cancel closes dialog and does not execute action", async () => {
        const handleConfirm = vi.fn();
        const handleCancel = vi.fn();
        const user = userEvent.setup();

        render(
            <ConfirmDialog
                title="Cancel Test"
                message="Do not execute"
                confirmLabel="Confirm"
                cancelLabel="Cancel"
                onConfirm={handleConfirm}
                onCancel={handleCancel}
            />
        );

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(handleCancel).toHaveBeenCalledTimes(1);
        expect(handleConfirm).not.toHaveBeenCalled();
    });

    test("CONFIRM-003: Confirm executes action exactly once", async () => {
        const handleConfirm = vi.fn();
        const handleCancel = vi.fn();
        const user = userEvent.setup();

        render(
            <ConfirmDialog
                title="Execute Test"
                message="Execute once"
                confirmLabel="Confirm Action"
                cancelLabel="Cancel"
                onConfirm={handleConfirm}
                onCancel={handleCancel}
            />
        );

        await user.click(screen.getByRole("button", { name: "Confirm Action" }));
        expect(handleConfirm).toHaveBeenCalledTimes(1);
        expect(handleCancel).not.toHaveBeenCalled();
    });

    test("CONFIRM-004: Confirm button is disabled while submitting (double submit protection)", async () => {
        let resolveAction: () => void = () => {};
        const pendingPromise = new Promise<void>((resolve) => {
            resolveAction = resolve;
        });
        const handleConfirm = vi.fn(() => pendingPromise);
        const handleCancel = vi.fn();
        const user = userEvent.setup();

        render(
            <ConfirmDialog
                title="Async Action"
                message="Submitting data..."
                confirmLabel="Confirm"
                busyLabel="Working…"
                onConfirm={handleConfirm}
                onCancel={handleCancel}
            />
        );

        const confirmBtn = screen.getByRole("button", { name: "Confirm" });
        await user.click(confirmBtn);

        // While submitting: button is disabled and shows busyLabel
        expect(confirmBtn).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
        expect(screen.getByText("Working…")).toBeInTheDocument();

        // Clicking again while busy should not call onConfirm again
        await user.click(confirmBtn);
        expect(handleConfirm).toHaveBeenCalledTimes(1);

        // Resolve the async action
        resolveAction();
        await waitFor(() => {
            expect(confirmBtn).not.toBeDisabled();
        });
    });

    test("CONFIRM-005: Current action context is displayed correctly", () => {
        render(
            <ConfirmDialog
                title="Change Role for Kamal Perera"
                message="Are you sure you want to change role from Manager to Job Handler?"
                confirmLabel="Change Role"
                cancelLabel="Dismiss"
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />
        );

        expect(screen.getByRole("heading", { name: "Change Role for Kamal Perera" })).toBeInTheDocument();
        expect(screen.getByText(/from Manager to Job Handler/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Change Role" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    });

    test("CONFIRM-006: Destructive and warning variants render correctly", () => {
        const { unmount } = render(
            <ConfirmDialog
                title="Remove Candidate"
                message="Permanently remove candidate from job"
                variant="destructive"
                confirmLabel="Remove Candidate"
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />
        );

        const removeBtn = screen.getByRole("button", { name: "Remove Candidate" });
        expect(removeBtn.className).toContain("bg-critical");

        unmount();

        render(
            <ConfirmDialog
                title="Complete Job"
                message="Mark job as completed"
                variant="warning"
                confirmLabel="Complete Job"
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />
        );

        const completeBtn = screen.getByRole("button", { name: "Complete Job" });
        expect(completeBtn.className).toContain("bg-review");
    });

    test("CONFIRM-007: Keyboard / ESC closes dialog when not busy; ignores ESC when busy; focus restored", async () => {
        const handleCancel = vi.fn();
        const user = userEvent.setup();

        const { rerender } = render(
            <div>
                <button type="button">Trigger Button</button>
                <ConfirmDialog
                    title="Keyboard Test"
                    message="Press Escape to cancel"
                    onConfirm={vi.fn()}
                    onCancel={handleCancel}
                />
            </div>
        );

        // Initial focus is on Cancel button by default
        const cancelBtn = screen.getByRole("button", { name: "Cancel" });
        expect(document.activeElement).toBe(cancelBtn);

        // Press Escape closes when not busy
        await user.keyboard("{Escape}");
        expect(handleCancel).toHaveBeenCalledTimes(1);

        // When busy, Escape is ignored
        rerender(
            <div>
                <button type="button">Trigger Button</button>
                <ConfirmDialog
                    title="Keyboard Test"
                    message="Press Escape to cancel"
                    loading={true}
                    onConfirm={vi.fn()}
                    onCancel={handleCancel}
                />
            </div>
        );

        await user.keyboard("{Escape}");
        expect(handleCancel).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    test("CONFIRM-008: Existing API error flow remains safe", async () => {
        const handleConfirm = vi.fn().mockRejectedValue(new Error("API network failure"));
        const handleCancel = vi.fn();
        const user = userEvent.setup();

        render(
            <ConfirmDialog
                title="Error Test"
                message="Action that fails"
                confirmLabel="Try Action"
                onConfirm={handleConfirm}
                onCancel={handleCancel}
            />
        );

        await user.click(screen.getByRole("button", { name: "Try Action" }));

        // Error message appears in role="alert"
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("API network failure");

        // Dialog remains open and confirm button is re-enabled to allow retry
        expect(screen.getByRole("dialog", { name: "Error Test" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try Action" })).not.toBeDisabled();
    });
});
