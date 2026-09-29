// Small in-process limit on how many jobs run at once.
//
// In memory only: it covers this one Node process, and the queue is lost on
// restart. Several app instances would each have their own limit; that setup
// needs a shared queue / worker system instead.

export class LimiterBusyError extends Error {
    constructor(reason) {
        super(`Concurrency limit: ${reason}`);
        this.name = "LimiterBusyError";
        this.reason = reason; // QUEUE_FULL or WAIT_TIMEOUT
    }
}

// At most maxConcurrent tasks run together; up to maxWaiting more wait for a
// free slot (first come, first served) for at most waitTimeoutMs. Anything
// beyond that is refused straight away instead of piling up.
export function createConcurrencyLimiter({ maxConcurrent, maxWaiting, waitTimeoutMs }) {
    let active = 0;
    let peakActive = 0;
    const waiting = [];

    function startNextWaiting() {
        while (active < maxConcurrent && waiting.length > 0) {
            const next = waiting.shift();
            clearTimeout(next.timer);
            active += 1;
            peakActive = Math.max(peakActive, active);
            next.resolve();
        }
    }

    function acquire() {
        if (active < maxConcurrent && waiting.length === 0) {
            active += 1;
            peakActive = Math.max(peakActive, active);
            return Promise.resolve();
        }

        if (waiting.length >= maxWaiting) {
            return Promise.reject(new LimiterBusyError("QUEUE_FULL"));
        }

        return new Promise((resolve, reject) => {
            const entry = { resolve };
            entry.timer = setTimeout(() => {
                waiting.splice(waiting.indexOf(entry), 1);
                reject(new LimiterBusyError("WAIT_TIMEOUT"));
            }, waitTimeoutMs);
            waiting.push(entry);
        });
    }

    function release() {
        active -= 1;
        startNextWaiting();
    }

    return {
        async run(task) {
            await acquire();
            try {
                return await task();
            } finally {
                release();
            }
        },
        get active() { return active; },
        get waiting() { return waiting.length; },
        get peakActive() { return peakActive; },
    };
}
