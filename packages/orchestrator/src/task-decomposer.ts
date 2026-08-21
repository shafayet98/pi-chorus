import { Agent, type AgentTool } from "@pi-chorus/agent-core";
import { streamSimple, getModel } from "@pi-chorus/ai/compat";
import type { RoleDefinition } from "@pi-chorus/coordination";
import type { TSchema } from "typebox";

/**
 * A single subtask in a decomposition plan.
 */
export interface Subtask {
	/** Short name for the subtask */
	name: string;
	/** The role that should handle this subtask */
	roleName: string;
	/** Detailed mandate for the agent */
	mandate: string;
	/** Dependencies on other subtask names (must complete first) */
	dependsOn: string[];
}

/**
 * The full decomposition plan output by the decomposer.
 */
export interface DecompositionPlan {
	/** Original mission description */
	mission: string;
	/** The subtasks to execute */
	subtasks: Subtask[];
	/** Any notes about the decomposition */
	notes: string;
}

/**
 * Decomposes a mission into subtasks using an LLM.
 *
 * The decomposer is given the mission description and the available role catalog.
 * It uses a structured tool call to output a DecompositionPlan — never free-form text.
 *
 * The decomposer is NOT an agent in the catalog. It's a one-shot LLM call that the
 * orchestrator makes before spawning anything.
 */
export class TaskDecomposer {
	private readonly model: any;

	constructor(modelName = "sonnet") {
		this.model = this.resolveModel(modelName);
	}

	/**
	 * Decompose a mission into subtasks.
	 *
	 * If no LLM is available (e.g., in tests), pass a plan directly via decomposeDirect().
	 */
	async decompose(mission: string, roles: RoleDefinition[]): Promise<DecompositionPlan> {
		const roleDescriptions = roles
			.map((r) => `- ${r.name}: ${r.description} [capabilities: ${r.capabilities.join(", ")}] [scope: ${r.pathScope.join(", ")}]`)
			.join("\n");

		let capturedPlan: DecompositionPlan | null = null;

		const submitPlanTool: AgentTool = {
			name: "submit_plan",
			label: "submit_plan",
			description: "Submit the decomposition plan.",
			parameters: {
				type: "object",
				properties: {
					subtasks: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string", description: "Short subtask name" },
								roleName: { type: "string", description: "Role from the catalog to assign" },
								mandate: { type: "string", description: "Detailed instructions for the agent" },
								dependsOn: {
									type: "array",
									items: { type: "string" },
									description: "Names of subtasks that must complete before this one",
								},
							},
							required: ["name", "roleName", "mandate", "dependsOn"],
						},
						description: "The subtasks that make up the mission",
					},
					notes: { type: "string", description: "Any notes about the decomposition" },
				},
				required: ["subtasks", "notes"],
			} as unknown as TSchema,
			execute: async (_toolCallId, params) => {
				const { subtasks, notes } = params as { subtasks: Subtask[]; notes: string };
				capturedPlan = { mission, subtasks, notes };
				return {
					content: [{ type: "text" as const, text: "Plan submitted." }],
					details: { plan: capturedPlan },
					terminate: true,
				};
			},
		};

		const systemPrompt = `You are a task decomposer for a multi-agent coding system.

Given a mission description and a catalog of available agent roles, break the mission into subtasks.
Each subtask is assigned to exactly one role from the catalog.

Rules:
- Only assign roles that exist in the catalog below.
- Each subtask gets a clear, specific mandate — enough for an agent to work independently.
- Specify dependencies: if subtask B needs subtask A's output, list A in dependsOn.
- Minimize dependencies — prefer parallel work where possible.
- Don't create subtasks for things that don't need code changes.
- Be concrete: "Implement the /api/users endpoint returning { id, name, email }" not "Build the backend".

Available roles:
${roleDescriptions}

Call the submit_plan tool with your decomposition. Do not output free-form text.`;

		const agent = new Agent({
			initialState: {
				systemPrompt,
				model: this.model,
				tools: [submitPlanTool],
			},
			streamFn: streamSimple,
		});

		await agent.prompt(mission);
		await agent.waitForIdle();

		if (!capturedPlan) {
			throw new Error("Decomposer did not produce a plan. The LLM may not have called the submit_plan tool.");
		}

		return capturedPlan;
	}

	/**
	 * Create a plan directly without calling an LLM.
	 * Useful for testing or when the plan is already known.
	 */
	decomposeDirect(mission: string, subtasks: Subtask[], notes = ""): DecompositionPlan {
		return { mission, subtasks, notes };
	}

	private resolveModel(modelName: string): any {
		const modelMap: Record<string, [string, string]> = {
			opus: ["anthropic", "claude-opus-4-20250514"],
			sonnet: ["anthropic", "claude-sonnet-4-20250514"],
			haiku: ["anthropic", "claude-haiku-4-5-20251001"],
		};

		const mapping = modelMap[modelName];
		if (mapping) {
			try {
				return getModel(mapping[0] as any, mapping[1] as any);
			} catch {
				// Fall through
			}
		}

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
}
