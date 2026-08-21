/**
 * Lamport clock for causal ordering of events across agents.
 * Each agent gets its own clock. On send, increment and attach.
 * On receive, merge (max + 1).
 */
export class LamportClock {
	private counter: number;

	constructor(initial = 0) {
		this.counter = initial;
	}

	/** Increment and return the new value. Used before emitting an event. */
	tick(): number {
		return ++this.counter;
	}

	/** Merge with a received clock value. Used when consuming a message from another agent. */
	merge(received: number): number {
		this.counter = Math.max(this.counter, received) + 1;
		return this.counter;
	}

	/** Current clock value without incrementing. */
	get value(): number {
		return this.counter;
	}
}
