/**
 * Deadlock detection and agent health monitoring.
 *
 * Deadlock — mutual waits are the default failure, not an edge case.
 * The watchdog detects cycles in the wait-for graph, enforces timeouts,
 * and kills the youngest agent in a cycle.
 */

export interface WaitEdge {
	/** Agent that is waiting */
	waiter: string;
	/** Agent being waited on */
	waitingFor: string;
	/** When the wait started */
	since: number;
}

export interface DeadlockInfo {
	/** The cycle of agent IDs */
	cycle: string[];
	/** The youngest agent in the cycle (to be killed) */
	youngest: string;
}

export interface AgentHealth {
	agentId: string;
	lastActivityAt: number;
	status: "active" | "waiting" | "stale";
}

export class Watchdog {
	private readonly waitEdges: WaitEdge[] = [];
	private readonly agentHealth = new Map<string, AgentHealth>();
	private readonly timeoutMs: number;

	constructor(timeoutMs = 5 * 60 * 1000) {
		this.timeoutMs = timeoutMs;
	}

	/** Record that an agent is waiting on another. */
	addWait(waiter: string, waitingFor: string): void {
		// Remove any existing wait for this waiter
		this.removeWait(waiter);
		this.waitEdges.push({ waiter, waitingFor, since: Date.now() });
		this.updateHealth(waiter, "waiting");
	}

	/** Remove a wait edge (agent is no longer waiting). */
	removeWait(waiter: string): void {
		const idx = this.waitEdges.findIndex((e) => e.waiter === waiter);
		if (idx >= 0) {
			this.waitEdges.splice(idx, 1);
		}
	}

	/** Record agent activity (keeps it from going stale). */
	recordActivity(agentId: string): void {
		this.updateHealth(agentId, "active");
	}

	/** Remove an agent from tracking (on shutdown). */
	removeAgent(agentId: string): void {
		this.removeWait(agentId);
		// Also remove edges where others wait on this agent
		for (let i = this.waitEdges.length - 1; i >= 0; i--) {
			if (this.waitEdges[i].waitingFor === agentId) {
				this.waitEdges.splice(i, 1);
			}
		}
		this.agentHealth.delete(agentId);
	}

	/**
	 * Detect cycles in the wait-for graph.
	 * Returns all deadlock cycles found.
	 */
	detectDeadlocks(): DeadlockInfo[] {
		const deadlocks: DeadlockInfo[] = [];
		const visited = new Set<string>();

		// Build adjacency: waiter → waitingFor
		const graph = new Map<string, string>();
		for (const edge of this.waitEdges) {
			graph.set(edge.waiter, edge.waitingFor);
		}

		for (const startNode of graph.keys()) {
			if (visited.has(startNode)) continue;

			const path: string[] = [];
			const pathSet = new Set<string>();
			let current: string | undefined = startNode;

			while (current && !visited.has(current)) {
				if (pathSet.has(current)) {
					// Found a cycle — extract it
					const cycleStart = path.indexOf(current);
					const cycle = path.slice(cycleStart);
					cycle.push(current); // Close the cycle

					// Find the youngest agent (most recently spawned / highest instance number)
					const youngest = this.findYoungest(cycle);

					deadlocks.push({ cycle, youngest });
					break;
				}

				path.push(current);
				pathSet.add(current);
				current = graph.get(current);
			}

			for (const node of path) {
				visited.add(node);
			}
		}

		return deadlocks;
	}

	/**
	 * Find agents that have been waiting longer than the timeout.
	 */
	getTimedOutWaits(): WaitEdge[] {
		const now = Date.now();
		return this.waitEdges.filter((e) => now - e.since > this.timeoutMs);
	}

	/**
	 * Find agents that haven't had activity within the timeout.
	 */
	getStaleAgents(): AgentHealth[] {
		const now = Date.now();
		const stale: AgentHealth[] = [];
		for (const health of this.agentHealth.values()) {
			if (now - health.lastActivityAt > this.timeoutMs) {
				health.status = "stale";
				stale.push(health);
			}
		}
		return stale;
	}

	/** Get all current wait edges. */
	getWaitEdges(): WaitEdge[] {
		return [...this.waitEdges];
	}

	/** Get all agent health records. */
	getAllHealth(): AgentHealth[] {
		return Array.from(this.agentHealth.values());
	}

	private updateHealth(agentId: string, status: "active" | "waiting"): void {
		const existing = this.agentHealth.get(agentId);
		if (existing) {
			existing.lastActivityAt = Date.now();
			existing.status = status;
		} else {
			this.agentHealth.set(agentId, {
				agentId,
				lastActivityAt: Date.now(),
				status,
			});
		}
	}

	private findYoungest(cycle: string[]): string {
		// The "youngest" is the one with the highest instance number
		let youngest = cycle[0];
		let highestNum = this.extractInstanceNumber(youngest);

		for (const agent of cycle) {
			const num = this.extractInstanceNumber(agent);
			if (num > highestNum) {
				highestNum = num;
				youngest = agent;
			}
		}
		return youngest;
	}

	private extractInstanceNumber(agentId: string): number {
		const match = agentId.match(/#(\d+)$/);
		return match ? parseInt(match[1], 10) : 0;
	}
}
