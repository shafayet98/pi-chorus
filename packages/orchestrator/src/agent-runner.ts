import { Agent, type AgentEvent, type AgentTool, type AgentMessage } from "@pi-chorus/agent-core";
import { NodeExecutionEnv } from "@pi-chorus/agent-core/node";
import {
	createReadTool,
	createWriteTool,
	createEditTool,
	createBashTool,
	type ExecutionToolContext,
	type AgentHarnessTool,
} from "@pi-chorus/agent-core";
import { streamSimple, getModel } from "@pi-chorus/ai/compat";
import type { RoleDefinition, AgentMessage as CoordMessage, DecisionRecord } from "@pi-chorus/coordination";
import type { LeaseManager, MessageBus, CapabilityRegistry, RoomManager } from "@pi-chorus/coordination";
import type { TraceStore } from "@pi-chorus/trace";
import type { TSchema } from "typebox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Binds a harness tool (which expects a context argument) into a regular AgentTool.
 */
function bindHarnessTool<TContext extends object>(
	harnessTool: AgentHarnessTool<TContext, any, any>,
	context: TContext,
): AgentTool {
	return {
		name: harnessTool.name,
		label: harnessTool.label,
		description: harnessTool.description,
		parameters: harnessTool.parameters,
		executionMode: harnessTool.executionMode,
		execute: (toolCallId, params, signal, onUpdate) => {
			return harnessTool.execute(toolCallId, params, signal, onUpdate, context);
		},
	};
}

/**
 * Runs a single agent instance in a worktree.
 *
 * Wraps pi-agent-core's Agent with:
 * - Scoped tools pointed at the worktree path
 * - Write/edit tools intercepted by the lease manager
 * - Coordination tools: send, read_messages, claim, release, signal_done
 * - Scratch space tools: read_scratch, write_scratch
 * - request_capability tool for requesting specialist agents
 * - Trace event emission on agent lifecycle events
 */
export interface AgentRunnerOptions {
	/** Agent instance ID (e.g., "frontend#1") */
	agentId: string;
	/** Role definition from the catalog */
	role: RoleDefinition;
	/** What the agent has been asked to do */
	mandate: string;
	/** Path to the agent's worktree */
	worktreePath: string;
	/** Lease manager for write enforcement */
	leaseManager: LeaseManager;
	/** Trace store for event emission */
	traceStore: TraceStore;
	/** Mission ID for trace correlation */
	missionId: string;
	/** Message bus for agent-to-agent communication */
	messageBus?: MessageBus;
	/** Capability registry for requesting specialist agents */
	capabilityRegistry?: CapabilityRegistry;
	/** Path to the shared scratch space */
	scratchPath?: string;
	/** Room manager for multi-party negotiation */
	roomManager?: RoomManager;
	/** Decision records to inject into the agent's briefing */
	initialDecisions?: DecisionRecord[];
	/** Callback when this agent requests a capability */
	onCapabilityRequest?: (capability: string, reason: string) => void;
}

export interface AgentRunResult {
	/** Whether the agent completed successfully */
	success: boolean;
	/** Messages produced during the run */
	messages: AgentMessage[];
	/** Error message if the agent failed */
	error?: string;
}

export class AgentRunner {
	private readonly options: AgentRunnerOptions;
	private agent: Agent | null = null;
	private env: NodeExecutionEnv | null = null;
	private readonly inbox: CoordMessage[] = [];
	private unsubscribeMessages?: () => void;

	constructor(options: AgentRunnerOptions) {
		this.options = options;
	}

	/** Run the agent with its mandate. */
	async run(): Promise<AgentRunResult> {
		const { agentId, role, mandate, worktreePath, leaseManager, traceStore, missionId, messageBus } = this.options;

		// Emit lifecycle start
		traceStore.emit(agentId, "lifecycle.start", { role: role.name, mandate }, [], missionId);

		// Subscribe to incoming messages
		if (messageBus) {
			this.unsubscribeMessages = messageBus.subscribe(agentId, (msg) => {
				this.inbox.push(msg);
				traceStore.emit(agentId, "message.deliver", {
					from: msg.from,
					type: msg.type,
				}, [], missionId);
			});
		}

		// Create execution environment pointed at the worktree
		this.env = new NodeExecutionEnv({ cwd: worktreePath });

		// Create tools with lease enforcement on writes
		const toolContext: ExecutionToolContext = { env: this.env };
		const tools = this.createTools(toolContext);

		// Resolve model
		const model = this.resolveModel(role.model);

		// Build system prompt
		const systemPrompt = this.buildSystemPrompt(role, agentId);

		// Create the agent
		this.agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				tools,
			},
			streamFn: streamSimple,
			shouldStopAfterTurn: () => false,
		});

		// Subscribe to events for tracing
		const lastCauses: string[] = [];
		this.agent.subscribe((event: AgentEvent) => {
			switch (event.type) {
				case "turn_start":
					traceStore.emit(agentId, "llm.request", {}, [...lastCauses], missionId);
					break;
				case "turn_end":
					traceStore.emit(agentId, "llm.response", {
						messageRole: event.message.role,
					}, [...lastCauses], missionId);
					break;
				case "tool_execution_start":
					traceStore.emit(agentId, "tool.start", {
						toolName: event.toolName,
						args: event.args,
					}, [...lastCauses], missionId);
					break;
				case "tool_execution_end": {
					const traceEvent = traceStore.emit(agentId, "tool.end", {
						toolName: event.toolName,
						isError: event.isError,
					}, [...lastCauses], missionId);
					lastCauses.length = 0;
					lastCauses.push(traceEvent.id);
					break;
				}
			}
		});

		try {
			// Build the full prompt: mandate + any injected decision records
			let fullPrompt = mandate;
			if (this.options.initialDecisions && this.options.initialDecisions.length > 0) {
				const decisionsText = this.options.initialDecisions
					.map(
						(d) =>
							`[Decision ${d.id}] Q: ${d.question} → ${d.decision} (${d.rationale}). Participants: ${d.participants.join(", ")}`,
					)
					.join("\n");
				fullPrompt += `\n\n--- Prior Decisions ---\nThe following decisions were made before you were spawned. Act on them:\n${decisionsText}`;
			}

			// Run the agent with the mandate as the user prompt
			await this.agent.prompt(fullPrompt);
			await this.agent.waitForIdle();

			traceStore.emit(agentId, "lifecycle.stop", { status: "done" }, [...lastCauses], missionId);

			return {
				success: true,
				messages: this.agent.state.messages,
			};
		} catch (e: any) {
			traceStore.emit(agentId, "lifecycle.crash", { error: e.message }, [...lastCauses], missionId);
			return {
				success: false,
				messages: this.agent?.state.messages ?? [],
				error: e.message,
			};
		} finally {
			this.unsubscribeMessages?.();
			await this.env.cleanup();
		}
	}

	/** Abort the running agent. */
	abort(): void {
		this.agent?.abort();
	}

	private createTools(context: ExecutionToolContext): AgentTool[] {
		const { agentId, role, leaseManager, traceStore, missionId, messageBus, capabilityRegistry, scratchPath } =
			this.options;

		// Bind harness tools to the execution context
		const readTool = bindHarnessTool(createReadTool(), context);
		const bashTool = bindHarnessTool(createBashTool({}), context);
		const baseWriteTool = bindHarnessTool(createWriteTool(), context);
		const baseEditTool = bindHarnessTool(createEditTool(), context);

		// Wrap write tool with lease enforcement
		const leasedWriteTool: AgentTool = {
			...baseWriteTool,
			execute: async (toolCallId, params, signal, onUpdate) => {
				const path = (params as any).path as string;
				if (!leaseManager.canWrite(agentId, path)) {
					const holder = leaseManager.getHolder(path);
					const msg = holder
						? `Cannot write to ${path}: claimed by ${holder}. Use the claim tool first.`
						: `Cannot write to ${path}: not claimed. Use the claim tool first.`;
					traceStore.emit(agentId, "lease.deny", { path, holder }, [], missionId);
					return {
						content: [{ type: "text" as const, text: msg }],
						details: { blocked: true, path },
					};
				}
				traceStore.emit(agentId, "file.write", { path }, [], missionId);
				return baseWriteTool.execute(toolCallId, params, signal, onUpdate);
			},
		};

		// Wrap edit tool with lease enforcement
		const leasedEditTool: AgentTool = {
			...baseEditTool,
			execute: async (toolCallId, params, signal, onUpdate) => {
				const path = (params as any).path as string;
				if (!leaseManager.canWrite(agentId, path)) {
					const holder = leaseManager.getHolder(path);
					const msg = holder
						? `Cannot edit ${path}: claimed by ${holder}. Use the claim tool first.`
						: `Cannot edit ${path}: not claimed. Use the claim tool first.`;
					traceStore.emit(agentId, "lease.deny", { path, holder }, [], missionId);
					return {
						content: [{ type: "text" as const, text: msg }],
						details: { blocked: true, path },
					};
				}
				traceStore.emit(agentId, "file.write", { path }, [], missionId);
				return baseEditTool.execute(toolCallId, params, signal, onUpdate);
			},
		};

		// --- Coordination tools ---

		const claimTool: AgentTool = {
			name: "claim",
			label: "claim",
			description: "Claim file paths for exclusive write access. You must claim files before writing to them.",
			parameters: {
				type: "object",
				properties: {
					paths: {
						type: "array",
						items: { type: "string" },
						description: "File paths to claim for exclusive write access",
					},
				},
				required: ["paths"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const paths = (params as any).paths as string[];
				const result = leaseManager.claim(agentId, role.name, paths);

				if (result.granted.length > 0) {
					traceStore.emit(agentId, "lease.grant", { paths: result.granted }, [], missionId);
				}
				if (result.denied.length > 0) {
					traceStore.emit(agentId, "lease.deny", { paths: result.denied }, [], missionId);
				}

				const parts: string[] = [];
				if (result.granted.length > 0) parts.push(`Claimed: ${result.granted.join(", ")}`);
				if (result.denied.length > 0) parts.push(`Denied: ${result.denied.join(", ")}`);

				return {
					content: [{ type: "text" as const, text: parts.join("\n") }],
					details: result,
				};
			},
		};

		const releaseTool: AgentTool = {
			name: "release",
			label: "release",
			description: "Release file path claims so other agents can write to them.",
			parameters: {
				type: "object",
				properties: {
					paths: {
						type: "array",
						items: { type: "string" },
						description: "File paths to release",
					},
				},
				required: ["paths"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const paths = (params as any).paths as string[];
				leaseManager.releasePaths(agentId, paths);
				traceStore.emit(agentId, "lease.release", { paths }, [], missionId);
				return {
					content: [{ type: "text" as const, text: `Released: ${paths.join(", ")}` }],
					details: { paths },
				};
			},
		};

		const doneTool: AgentTool = {
			name: "signal_done",
			label: "signal_done",
			description: "Signal that your work is complete. Call this when you have finished your assigned task.",
			parameters: { type: "object", properties: {}, required: [] } as unknown as TSchema,
			execute: async () => {
				return {
					content: [{ type: "text" as const, text: "Work complete. Signaling done." }],
					details: { done: true },
					terminate: true,
				};
			},
		};

		// --- Messaging tools ---

		const sendTool: AgentTool = {
			name: "send",
			label: "send",
			description:
				"Send a typed message to another agent. Use this for direct agent-to-agent communication. " +
				"Message types: INFO (general info), REQUEST_INTERFACE (ask for an interface definition), " +
				"PROPOSE (propose a decision), BLOCKED_ON (signal a dependency).",
			parameters: {
				type: "object",
				properties: {
					to: { type: "string", description: 'Target agent ID (e.g., "backend#1")' },
					type: {
						type: "string",
						enum: ["INFO", "REQUEST_INTERFACE", "PROPOSE", "BLOCKED_ON"],
						description: "Message type",
					},
					content: { type: "string", description: "Message content" },
				},
				required: ["to", "type", "content"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const { to, type, content } = params as { to: string; type: any; content: string };
				if (!messageBus) {
					return {
						content: [{ type: "text" as const, text: "Messaging is not available in this run." }],
						details: { error: "no_message_bus" },
					};
				}

				const clock = traceStore.clockFor(agentId).tick();
				const msg = messageBus.send(agentId, to, type, { content }, clock);
				traceStore.emit(
					agentId,
					"message.send",
					{ to, messageType: type, messageId: msg.id, content },
					[],
					missionId,
				);

				return {
					content: [{ type: "text" as const, text: `Sent ${type} message to ${to}.` }],
					details: { messageId: msg.id, to, type },
				};
			},
		};

		const readMessagesTool: AgentTool = {
			name: "read_messages",
			label: "read_messages",
			description:
				"Read messages from your inbox. Returns all unread messages from other agents. " +
				"Messages are consumed on read — they won't appear again.",
			parameters: { type: "object", properties: {}, required: [] } as unknown as TSchema,
			execute: async () => {
				const messages = this.inbox.splice(0);
				for (const msg of messages) {
					traceStore.emit(agentId, "message.consume", {
						from: msg.from,
						type: msg.type,
						messageId: msg.id,
					}, [], missionId);
				}

				if (messages.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No new messages." }],
						details: { count: 0 },
					};
				}

				const formatted = messages
					.map((m) => `[${m.type}] from ${m.from}: ${(m.payload as any)?.content ?? JSON.stringify(m.payload)}`)
					.join("\n");

				return {
					content: [{ type: "text" as const, text: `${messages.length} message(s):\n${formatted}` }],
					details: { count: messages.length, messages },
				};
			},
		};

		// --- Capability request tool ---

		const requestCapabilityTool: AgentTool = {
			name: "request_capability",
			label: "request_capability",
			description:
				"Request a specialist agent for a capability you need (e.g., 'database', 'testing', 'api-schema'). " +
				"The orchestrator will check the capability registry and spawn an agent if needed.",
			parameters: {
				type: "object",
				properties: {
					capability: { type: "string", description: "The capability tag needed" },
					reason: { type: "string", description: "Why you need this capability" },
				},
				required: ["capability", "reason"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const { capability, reason } = params as { capability: string; reason: string };
				traceStore.emit(agentId, "capability.request", { capability, reason }, [], missionId);

				// Check if an agent with this capability already exists
				if (capabilityRegistry) {
					const existing = capabilityRegistry.findByCapability(capability);
					if (existing) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Agent "${existing.agentId}" (role: ${existing.roleName}) already provides "${capability}". You can send messages to them directly.`,
								},
							],
							details: { existing: existing.agentId, capability },
						};
					}
				}

				// Notify the orchestrator
				this.options.onCapabilityRequest?.(capability, reason);

				return {
					content: [
						{
							type: "text" as const,
							text: `Requested capability "${capability}". The orchestrator will handle spawning if a matching role exists. Continue with other work in the meantime.`,
						},
					],
					details: { capability, reason, requested: true },
				};
			},
		};

		// --- Scratch space tools ---

		const readScratchTool: AgentTool = {
			name: "read_scratch",
			label: "read_scratch",
			description:
				"Read a file from the shared scratch space. Use this to read data shared by other agents " +
				"(e.g., generated schemas, interface stubs) before their worktrees are merged.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Relative path within scratch space" },
				},
				required: ["path"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const relativePath = (params as any).path as string;
				if (!scratchPath) {
					return {
						content: [{ type: "text" as const, text: "Scratch space is not configured." }],
						details: { error: "no_scratch" },
					};
				}
				const fullPath = join(scratchPath, relativePath);
				if (!existsSync(fullPath)) {
					return {
						content: [{ type: "text" as const, text: `File not found in scratch space: ${relativePath}` }],
						details: { error: "not_found", path: relativePath },
					};
				}
				const content = readFileSync(fullPath, "utf-8");
				return {
					content: [{ type: "text" as const, text: content }],
					details: { path: relativePath, size: content.length },
				};
			},
		};

		const writeScratchTool: AgentTool = {
			name: "write_scratch",
			label: "write_scratch",
			description:
				"Write a file to the shared scratch space. Use this to share data with other agents " +
				"(e.g., generated schemas, interface definitions) before your worktree is merged.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Relative path within scratch space" },
					content: { type: "string", description: "File content to write" },
				},
				required: ["path", "content"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const { path: relativePath, content: fileContent } = params as { path: string; content: string };
				if (!scratchPath) {
					return {
						content: [{ type: "text" as const, text: "Scratch space is not configured." }],
						details: { error: "no_scratch" },
					};
				}
				const fullPath = join(scratchPath, relativePath);
				const dir = dirname(fullPath);
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				writeFileSync(fullPath, fileContent, "utf-8");
				return {
					content: [{ type: "text" as const, text: `Written to scratch: ${relativePath}` }],
					details: { path: relativePath, size: fileContent.length },
				};
			},
		};

		// --- Room tools ---

		const { roomManager, initialDecisions } = this.options;

		const openRoomTool: AgentTool = {
			name: "open_room",
			label: "open_room",
			description:
				"Open an ephemeral negotiation room with other agents. Use this when you need to reach a " +
				"multi-party decision (e.g., agreeing on an API contract). The room has a turn budget — " +
				"if it expires without resolution, the orchestrator will arbitrate.",
			parameters: {
				type: "object",
				properties: {
					topic: { type: "string", description: "Short topic name" },
					question: { type: "string", description: "The specific question to resolve" },
					invite: {
						type: "array",
						items: { type: "string" },
						description: "Agent IDs to invite (e.g., [\"backend#1\"])",
					},
					turn_budget: {
						type: "number",
						description: "Max turns before orchestrator arbitrates (default: 10)",
					},
				},
				required: ["topic", "question", "invite"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const { topic, question, invite, turn_budget } = params as {
					topic: string;
					question: string;
					invite: string[];
					turn_budget?: number;
				};
				if (!roomManager) {
					return {
						content: [{ type: "text" as const, text: "Room negotiation is not available." }],
						details: { error: "no_room_manager" },
					};
				}

				const room = roomManager.open(agentId, topic, question, invite, turn_budget ?? 10);
				traceStore.emit(agentId, "room.open", {
					roomId: room.id,
					topic,
					question,
					members: room.members,
					turnBudget: room.turnBudget,
				}, [], missionId);

				// Notify invited agents
				if (messageBus) {
					for (const invitee of invite) {
						messageBus.send(agentId, invitee, "INFO", {
							content: `You've been invited to room "${topic}" (${room.id}). Question: ${question}. Use send_to_room to participate.`,
						}, traceStore.clockFor(agentId).tick());
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Opened room "${topic}" (${room.id}) with ${invite.join(", ")}. Question: ${question}. Budget: ${room.turnBudget} turns.`,
						},
					],
					details: { roomId: room.id, topic, members: room.members },
				};
			},
		};

		const sendToRoomTool: AgentTool = {
			name: "send_to_room",
			label: "send_to_room",
			description:
				"Send a message to a negotiation room. Use message types: PROPOSE (propose a solution), " +
				"ACCEPT (accept a proposal), REJECT (reject with reason). " +
				"When all participants accept, the room resolves with a decision record.",
			parameters: {
				type: "object",
				properties: {
					room_id: { type: "string", description: "The room ID" },
					type: {
						type: "string",
						enum: ["PROPOSE", "ACCEPT", "REJECT", "INFO"],
						description: "Message type",
					},
					content: { type: "string", description: "Message content" },
				},
				required: ["room_id", "type", "content"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const { room_id, type, content: msgContent } = params as {
					room_id: string;
					type: any;
					content: string;
				};
				if (!roomManager) {
					return {
						content: [{ type: "text" as const, text: "Room negotiation is not available." }],
						details: { error: "no_room_manager" },
					};
				}

				const room = roomManager.getRoom(room_id);
				if (!room) {
					return {
						content: [{ type: "text" as const, text: `Room ${room_id} not found.` }],
						details: { error: "not_found" },
					};
				}

				if (room.status !== "open") {
					const decision = room.decision;
					return {
						content: [
							{
								type: "text" as const,
								text: `Room is ${room.status}. ${decision ? `Decision: ${decision.decision}` : ""}`,
							},
						],
						details: { status: room.status, decision },
					};
				}

				// Record the turn
				const withinBudget = roomManager.recordTurn(room_id);

				// Emit trace event for the room message
				traceStore.emit(agentId, "message.send", {
					to: "room:" + room_id,
					messageType: type,
					content: msgContent,
					roomId: room_id,
					roomTopic: room.topic,
				}, [], missionId);

				// Broadcast to room members via message bus
				if (messageBus) {
					for (const member of room.members) {
						if (member !== agentId) {
							messageBus.send(agentId, member, type, {
								content: msgContent,
								roomId: room_id,
							}, traceStore.clockFor(agentId).tick(), room_id);
						}
					}
				}

				if (!withinBudget) {
					traceStore.emit(agentId, "room.resolve", {
						roomId: room_id,
						reason: "turn_budget_exhausted",
					}, [], missionId);

					return {
						content: [
							{
								type: "text" as const,
								text: `Room "${room.topic}" hit its turn budget (${room.turnBudget}). The orchestrator will arbitrate.`,
							},
						],
						details: { roomId: room_id, expired: true },
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `[${type}] sent to room "${room.topic}" (turn ${room.turnsUsed}/${room.turnBudget}).`,
						},
					],
					details: { roomId: room_id, type, turnsUsed: room.turnsUsed },
				};
			},
		};

		const resolveRoomTool: AgentTool = {
			name: "resolve_room",
			label: "resolve_room",
			description:
				"Resolve a room with a decision. Only the room asker should call this after participants have agreed. " +
				"This creates a durable decision record that other agents can read.",
			parameters: {
				type: "object",
				properties: {
					room_id: { type: "string", description: "The room ID" },
					decision: { type: "string", description: "The agreed-upon decision" },
					rationale: { type: "string", description: "Why this decision was made" },
				},
				required: ["room_id", "decision", "rationale"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const { room_id, decision, rationale } = params as {
					room_id: string;
					decision: string;
					rationale: string;
				};
				if (!roomManager) {
					return {
						content: [{ type: "text" as const, text: "Room negotiation is not available." }],
						details: { error: "no_room_manager" },
					};
				}

				const record = roomManager.resolve(room_id, decision, rationale);
				traceStore.emit(agentId, "room.resolve", {
					roomId: room_id,
					decisionId: record.id,
					decision,
				}, [], missionId);
				traceStore.emit(agentId, "decision.record", {
					decisionId: record.id,
					question: record.question,
					decision: record.decision,
					participants: record.participants,
				}, [], missionId);

				// Notify all room members
				if (messageBus) {
					const room = roomManager.getRoom(room_id);
					if (room) {
						for (const member of room.members) {
							if (member !== agentId) {
								messageBus.send(agentId, member, "INFO", {
									content: `Room "${room.topic}" resolved. Decision: ${decision}. Use read_decision("${record.id}") for details.`,
								}, traceStore.clockFor(agentId).tick());
							}
						}
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Room resolved. Decision record ${record.id} created: ${decision}`,
						},
					],
					details: { decisionId: record.id, decision, rationale },
				};
			},
		};

		const readDecisionTool: AgentTool = {
			name: "read_decision",
			label: "read_decision",
			description:
				"Read a decision record by ID. Decision records are the structured output of negotiation rooms. " +
				"They contain the question, decision, rationale, and participants.",
			parameters: {
				type: "object",
				properties: {
					decision_id: { type: "string", description: "The decision record ID" },
				},
				required: ["decision_id"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const { decision_id } = params as { decision_id: string };
				if (!roomManager) {
					return {
						content: [{ type: "text" as const, text: "Room negotiation is not available." }],
						details: { error: "no_room_manager" },
					};
				}

				const record = roomManager.getDecision(decision_id);
				if (!record) {
					return {
						content: [{ type: "text" as const, text: `Decision ${decision_id} not found.` }],
						details: { error: "not_found" },
					};
				}

				const formatted = [
					`Question: ${record.question}`,
					`Decision: ${record.decision}`,
					`Rationale: ${record.rationale}`,
					`Participants: ${record.participants.join(", ")}`,
					record.dissents.length > 0 ? `Dissents: ${record.dissents.join(", ")}` : null,
				]
					.filter(Boolean)
					.join("\n");

				return {
					content: [{ type: "text" as const, text: formatted }],
					details: record,
				};
			},
		};

		// Build the tool set based on the role's tool list
		const toolRegistry = new Map<string, AgentTool>([
			["read", readTool],
			["write", leasedWriteTool],
			["edit", leasedEditTool],
			["bash", bashTool],
		]);

		const enabledTools: AgentTool[] = [];
		for (const toolName of role.tools) {
			const tool = toolRegistry.get(toolName);
			if (tool) enabledTools.push(tool);
		}

		// Always include coordination tools
		enabledTools.push(claimTool, releaseTool, doneTool, sendTool, readMessagesTool, requestCapabilityTool);

		// Include room tools if room manager is configured
		if (roomManager) {
			enabledTools.push(openRoomTool, sendToRoomTool, resolveRoomTool, readDecisionTool);
		}

		// Include scratch tools if scratch space is configured
		if (scratchPath) {
			enabledTools.push(readScratchTool, writeScratchTool);
		}

		return enabledTools;
	}

	private resolveModel(modelName: string): any {
		const modelMap: Record<string, [string, string]> = {
			opus: ["anthropic", "claude-opus-4-6"],
			sonnet: ["anthropic", "claude-sonnet-4-6"],
			haiku: ["anthropic", "claude-haiku-4-5"],
			"sonnet-4.5": ["anthropic", "claude-sonnet-4-5"],
			"opus-4.5": ["anthropic", "claude-opus-4-5"],
			"gpt-4o": ["openai", "gpt-4o"],
			"gpt-4.1": ["openai", "gpt-4.1"],
		};

		const mapping = modelMap[modelName];
		if (mapping) {
			try {
				return getModel(mapping[0] as any, mapping[1] as any);
			} catch {
				// Fall through
			}
		}

		// Minimal model object for unknown names
		return {
			id: modelName,
			name: modelName,
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "",
			reasoning: false,
			input: [],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		};
	}

	private buildSystemPrompt(role: RoleDefinition, agentId: string): string {
		const sections = [
			role.systemPrompt,
			"",
			`You are agent instance "${agentId}" (role: ${role.name}).`,
			"Your working directory is your private worktree. You may only write to files you have claimed.",
			"",
			"Available coordination tools:",
			"- claim(paths): Claim file paths before writing to them",
			"- release(paths): Release file claims when done with files",
			"- send(to, type, content): Send a message to another agent",
			"- read_messages(): Read messages from your inbox",
			"- request_capability(capability, reason): Request a specialist agent",
			"- signal_done(): Signal that your work is complete",
		];

		if (this.options.roomManager) {
			sections.push(
				"- open_room(topic, question, invite): Open a negotiation room with other agents",
				"- send_to_room(room_id, type, content): Send PROPOSE/ACCEPT/REJECT to a room",
				"- resolve_room(room_id, decision, rationale): Resolve a room with a decision",
				"- read_decision(decision_id): Read a decision record from a resolved room",
			);
		}

		if (this.options.scratchPath) {
			sections.push(
				"- read_scratch(path): Read shared data from scratch space",
				"- write_scratch(path, content): Write shared data to scratch space",
			);
		}

		sections.push(
			"",
			`Your path scope (files you are allowed to claim): ${role.pathScope.join(", ")}`,
			"",
			"IMPORTANT: Always claim files before writing. Use send() to coordinate with other agents. Call signal_done() when finished.",
		);

		return sections.join("\n");
	}
}
