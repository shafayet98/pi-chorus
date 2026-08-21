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
import type { RoleDefinition } from "@pi-chorus/coordination";
import type { LeaseManager } from "@pi-chorus/coordination";
import type { TraceStore } from "@pi-chorus/trace";
import type { TSchema } from "typebox";

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

	constructor(options: AgentRunnerOptions) {
		this.options = options;
	}

	/** Run the agent with its mandate. */
	async run(): Promise<AgentRunResult> {
		const { agentId, role, mandate, worktreePath, leaseManager, traceStore, missionId } = this.options;

		// Emit lifecycle start
		traceStore.emit(agentId, "lifecycle.start", { role: role.name, mandate }, [], missionId);

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
			// Run the agent with the mandate as the user prompt
			await this.agent.prompt(mandate);
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
			await this.env.cleanup();
		}
	}

	/** Abort the running agent. */
	abort(): void {
		this.agent?.abort();
	}

	private createTools(context: ExecutionToolContext): AgentTool[] {
		const { agentId, role, leaseManager, traceStore, missionId } = this.options;

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

		// Claim tool — lets the agent request file leases
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

		// Release tool
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

		// Signal done tool — terminates the agent loop
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
		enabledTools.push(claimTool, releaseTool, doneTool);

		return enabledTools;
	}

	private resolveModel(modelName: string): any {
		const modelMap: Record<string, [string, string]> = {
			opus: ["anthropic", "claude-opus-4-20250514"],
			sonnet: ["anthropic", "claude-sonnet-4-20250514"],
			haiku: ["anthropic", "claude-haiku-4-5-20251001"],
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
			api: "messages",
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
		return [
			role.systemPrompt,
			"",
			`You are agent instance "${agentId}" (role: ${role.name}).`,
			"Your working directory is your private worktree. You may only write to files you have claimed.",
			"",
			"Available coordination tools:",
			"- claim(paths): Claim file paths before writing to them",
			"- release(paths): Release file claims when done with files",
			"- signal_done(): Signal that your work is complete",
			"",
			`Your path scope (files you are allowed to claim): ${role.pathScope.join(", ")}`,
			"",
			"IMPORTANT: Always claim files before writing to them. Always call signal_done() when finished.",
		].join("\n");
	}
}
