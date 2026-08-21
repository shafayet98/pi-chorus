/**
 * Message types are typed and schema-enforced.
 * Free-form agent chat degrades into mutual agreement and triples the token bill.
 */
export type MessageType =
	| "CLAIM"
	| "REQUEST_INTERFACE"
	| "PROPOSE"
	| "ACCEPT"
	| "REJECT"
	| "BLOCKED_ON"
	| "DONE"
	| "INFO";

/**
 * A typed message between agents.
 */
export interface AgentMessage {
	id: string;
	from: string;
	to: string;
	type: MessageType;
	payload: unknown;
	/** Lamport clock value at send time */
	clock: number;
	timestamp: number;
	/** If this message is part of a room conversation */
	roomId?: string;
}

/**
 * Room status lifecycle.
 */
export type RoomStatus = "open" | "resolved" | "expired";

/**
 * An ephemeral room for multi-party negotiation.
 * Opened with a stated question, bounded membership, and an exit condition.
 * Three agents, one decision, then it dissolves.
 */
export interface Room {
	id: string;
	topic: string;
	question: string;
	/** Agent who opened the room and asks the question */
	askerId: string;
	/** Invited agent IDs */
	members: string[];
	status: RoomStatus;
	/** Max turns before the orchestrator arbitrates */
	turnBudget: number;
	turnsUsed: number;
	/** The decision record, once resolved */
	decision?: DecisionRecord;
}

/**
 * Structured output of a room. Durable, injectable into agents who were never present.
 */
export interface DecisionRecord {
	id: string;
	roomId: string;
	question: string;
	decision: string;
	rationale: string;
	participants: string[];
	dissents: string[];
	timestamp: number;
	causes: string[];
}

/**
 * A file-path lease held by an agent.
 */
export interface Lease {
	agentId: string;
	paths: string[];
	grantedAt: number;
}

/**
 * An entry in the capability registry.
 */
export interface CapabilityEntry {
	/** The agent instance ID (e.g., "frontend#1") */
	agentId: string;
	/** Role name from the catalog */
	roleName: string;
	/** Capability tags this agent provides */
	capabilities: string[];
	/** Paths this agent has claimed */
	claimedPaths: string[];
	/** Whether this agent is still active */
	active: boolean;
}

/**
 * A role definition from the catalog (roles/*.yaml).
 */
export interface RoleDefinition {
	name: string;
	description: string;
	capabilities: string[];
	systemPrompt: string;
	model: string;
	tools: string[];
	pathScope: string[];
	localGate?: string;
}
