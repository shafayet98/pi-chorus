import { randomUUID } from "node:crypto";
import type { MissionConfig, Mission, MissionResult, AgentInstance } from "./types.ts";
import { RoleCatalog } from "./role-catalog.ts";

/**
 * The orchestrator is the runtime — not a peer agent.
 *
 * It decomposes tasks, spawns agents from the role catalog, manages the mission
 * lifecycle, coordinates integration, and enforces caps.
 *
 * TODO: This is a scaffold. The full implementation will:
 * - Use an LLM to decompose tasks into subtasks
 * - Spawn pi-agent-core instances per subtask
 * - Wire up coordination tools (send, claim, request_capability, etc.)
 * - Manage worktrees and the integration pipeline
 * - Handle request_capability, room arbitration, deadlock detection
 * - Enforce max agents, wall time, token budgets, repair rounds
 */
export class Orchestrator {
	private readonly config: MissionConfig;
	private readonly catalog: RoleCatalog;
	private mission: Mission | null = null;

	constructor(config: MissionConfig) {
		this.config = config;
		this.catalog = new RoleCatalog(config.catalogPath);
	}

	/** Start a mission. */
	async run(): Promise<MissionResult> {
		// Load the role catalog
		const roles = this.catalog.load();

		// Create the mission
		this.mission = {
			id: randomUUID(),
			description: this.config.description,
			status: "planning",
			gateCommands: this.config.gate.split("&&").map((c) => c.trim()),
			startedAt: Date.now(),
			agents: [],
		};

		// TODO: Decompose task using LLM
		// TODO: Spawn agents
		// TODO: Run coordination loop
		// TODO: Integration + gate

		this.mission.status = "succeeded";
		this.mission.endedAt = Date.now();

		return {
			mission: this.mission,
			gatePassed: false,
			totalTokens: 0,
			wallTimeMs: (this.mission.endedAt ?? Date.now()) - this.mission.startedAt,
			repairRounds: 0,
		};
	}

	/** Get the current mission state. */
	getMission(): Mission | null {
		return this.mission;
	}
}
