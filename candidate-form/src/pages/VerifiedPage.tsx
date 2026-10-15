// Task 1 placeholder after a successful verification. The Additional Details
// form itself comes in Task 2.
export function VerifiedPage({ expiresAt, onDone }: { expiresAt: string; onDone: () => void }) {
    const time = new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
        <section className="card" aria-live="polite">
            <h1>Verification successful</h1>
            <p className="lead">Your details were verified. This session ends at {time}.</p>
            <button type="button" onClick={onDone}>Done</button>
        </section>
    );
}
