import type { RoleDefinition } from "@pi-chorus/coordination";

export type MissionStatus = "planning" | "running" | "succeeded" | "failed" | "aborted";

/**
 * A mission is the top-level unit of work.
 * You give it a task, not a headcount.
 */
export interface Mission {
	id: string;
	description: string;
	status: MissionStatus;
	/** Gate commands that define "done" */
	gateCommands: string[];
	/** When the mission started */
	startedAt: number;
	/** When the mission ended */
	endedAt?: number;
	/** Agent instances spawned for this mission */
	agents: AgentInstance[];
}

/**
 * Configuration for starting a mission.
 */
export interface MissionConfig {
	/** What needs to be built/done */
	description: string;
	/** Verification gate command (e.g., "npm test && npm run build") */
	gate: string;
	/** Path to the repository to work on */
	repoPath: string;
	/** Path to the role catalog directory */
	catalogPath: string;
	/** Maximum number of agents to spawn */
	maxAgents?: number;
	/** Maximum repair rounds after gate failure */
	maxRepairRounds?: number;
	/** Maximum wall time in ms */
	maxWallTime?: number;
	/** Maximum total tokens across all agents */
	maxTokens?: number;
	/** Human-in-the-loop mode */
	humanApproval?: boolean;
}

export interface MissionResult {
	mission: Mission;
	/** Whether the verification gate passed */
	gatePassed: boolean;
	/** Total tokens used across all agents */
	totalTokens: number;
	/** Total wall time in ms */
	wallTimeMs: number;
	/** Number of repair rounds attempted */
	repairRounds: number;
}

/**
 * A runtime instance of a role.
 */
export interface AgentInstance {
	/** Instance ID (e.g., "frontend#1") */
	id: string;
	/** Role name from the catalog */
	roleName: string;
	/** The role definition */
	role: RoleDefinition;
	/** Current status */
	status: "spawning" | "active" | "done" | "failed" | "blocked";
	/** What this agent was asked to do */
	mandate: string;
	/** Who requested this agent's creation */
	spawnedBy: string;
	/** Path to this agent's worktree */
	worktreePath?: string;
}
