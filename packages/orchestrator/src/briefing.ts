import type { DecisionRecord, CapabilityEntry } from "@pi-chorus/coordination";

/**
 * Builds a cold-start briefing for a late-spawned or respawned agent.
 *
 * A new agent gets its mandate, relevant decision records, and a capability
 * registry snapshot. NOT the full mission history — that's how a $2 run
 * stays $2.
 *
 * If this is a respawn after failure, the failure context is included so the
 * agent can avoid the same mistake.
 */
export interface BriefingContext {
	/** The agent's assigned task */
	mandate: string;
	/** Decision records from resolved rooms */
	decisions: DecisionRecord[];
	/** Currently active agents and their capabilities */
	activeAgents: CapabilityEntry[];
	/** Failure context if this is a respawn */
	failureContext?: FailureContext;
}

export interface FailureContext {
	/** What error occurred */
	error: string;
	/** Which attempt this is */
	attempt: number;
	/** Max attempts allowed */
	maxAttempts: number;
}

/**
 * Build a briefing prompt from a BriefingContext.
 * This is what gets sent as the user prompt to a newly spawned agent.
 */
export function buildBriefing(ctx: BriefingContext): string {
	const sections: string[] = [ctx.mandate];

	// Inject prior decisions
	if (ctx.decisions.length > 0) {
		const decisionsText = ctx.decisions
			.map(
				(d) =>
					`[Decision ${d.id}] Q: ${d.question} → ${d.decision} (${d.rationale}). Participants: ${d.participants.join(", ")}`,
			)
			.join("\n");
		sections.push(
			"",
			"--- Prior Decisions ---",
			"The following decisions were made before you were spawned. Act on them:",
			decisionsText,
		);
	}

	// Inject active agents roster
	if (ctx.activeAgents.length > 0) {
		const roster = ctx.activeAgents
			.map((a) => `- ${a.agentId} (${a.roleName}): [${a.capabilities.join(", ")}]`)
			.join("\n");
		sections.push(
			"",
			"--- Active Agents ---",
			"You can send messages to these agents:",
			roster,
		);
	}

	// Inject failure context
	if (ctx.failureContext) {
		sections.push(
			"",
			"--- RESPAWN NOTICE ---",
			`This is attempt ${ctx.failureContext.attempt} of ${ctx.failureContext.maxAttempts}.`,
			`Previous attempt failed with: ${ctx.failureContext.error}`,
			"Avoid the same failure. Adjust your approach if needed.",
		);
	}

	return sections.join("\n");
}
