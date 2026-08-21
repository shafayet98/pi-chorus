/**
 * All possible event kinds emitted by the tracing system.
 */
export type EventKind =
	| "lifecycle.start"
	| "lifecycle.stop"
	| "lifecycle.crash"
	| "llm.request"
	| "llm.response"
	| "tool.start"
	| "tool.end"
	| "message.send"
	| "message.deliver"
	| "message.consume"
	| "wait.begin"
	| "wait.end"
	| "lease.grant"
	| "lease.deny"
	| "lease.release"
	| "agent.spawn"
	| "room.open"
	| "room.join"
	| "room.resolve"
	| "decision.record"
	| "capability.request"
	| "capability.deny"
	| "capability.unmatched"
	| "file.write"
	| "file.delete"
	| "git.commit"
	| "git.merge"
	| "git.conflict"
	| "gate.run"
	| "gate.pass"
	| "gate.fail";

/**
 * Base trace event. Every event in the system conforms to this shape.
 * The `causes` array turns the flat log into a causal DAG.
 */
export interface TraceEvent {
	/** Unique event ID */
	id: string;
	/** Lamport clock value — causal ordering, not wall time */
	clock: number;
	/** Which agent emitted this event */
	agentId: string;
	/** The kind of event */
	kind: EventKind;
	/** IDs of events that causally precede this one */
	causes: string[];
	/** Content-addressed hash of the payload */
	payloadHash: string;
	/** Wall-clock timestamp (secondary, for display only) */
	timestamp: number;
	/** Mission ID this event belongs to */
	missionId: string;
}

export interface LifecycleEvent extends TraceEvent {
	kind: "lifecycle.start" | "lifecycle.stop" | "lifecycle.crash";
}

export interface LlmEvent extends TraceEvent {
	kind: "llm.request" | "llm.response";
}

export interface ToolEvent extends TraceEvent {
	kind: "tool.start" | "tool.end";
}

export interface MessageEvent extends TraceEvent {
	kind: "message.send" | "message.deliver" | "message.consume";
}

export interface LeaseEvent extends TraceEvent {
	kind: "lease.grant" | "lease.deny" | "lease.release";
}

export interface AgentSpawnEvent extends TraceEvent {
	kind: "agent.spawn";
}

export interface RoomEvent extends TraceEvent {
	kind: "room.open" | "room.join" | "room.resolve";
}

export interface GateEvent extends TraceEvent {
	kind: "gate.run" | "gate.pass" | "gate.fail";
}
