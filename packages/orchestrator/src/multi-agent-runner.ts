import { randomUUID } from "node:crypto";
import { MessageBus, LeaseManager, CapabilityRegistry } from "@pi-chorus/coordination";
import type { RoleDefinition } from "@pi-chorus/coordination";
import { WorktreeManager, VerificationGate } from "@pi-chorus/worktree";
import type { MergeResult, GateResult } from "@pi-chorus/worktree";
import type { TraceStore } from "@pi-chorus/trace";
import { AgentRunner } from "./agent-runner.ts";
import type { AgentRunResult } from "./agent-runner.ts";

/**
 * Describes a single agent to spawn.
 */
export interface AgentSpec {
	/** Role name from the catalog */
	roleName: string;
	/** What this agent should do */
	mandate: string;
	/** Role definition (resolved from catalog) */
	role: RoleDefinition;
}

/**
 * Result of a multi-agent mission run.
 */
export interface MultiAgentResult {
	missionId: string;
	/** Per-agent results keyed by agent ID */
	agentResults: Map<string, AgentRunResult>;
	/** Per-agent merge results keyed by agent ID */
	mergeResults: Map<string, MergeResult>;
	/** Verification gate result (if run) */
	gateResult?: GateResult;
	/** Whether the overall mission succeeded */
	success: boolean;
	/** Agents that failed */
	failedAgents: string[];
	/** Agents that had merge conflicts */
	conflictAgents: string[];
}

export interface MultiAgentRunnerOptions {
	/** Path to the repository */
	repoPath: string;
	/** Name of the integration branch */
	integrationBranch: string;
	/** Path for shared scratch space */
	scratchPath: string;
	/** Trace store for event emission */
	traceStore: TraceStore;
	/** Verification gate command (e.g., "npm test && npm run build") */
	gateCommand?: string;
	/** Maximum number of agents */
	maxAgents?: number;
}

/**
 * Orchestrates multiple agents running in parallel worktrees.
 *
 * Wires all agents to the same MessageBus, LeaseManager, CapabilityRegistry,
 * and TraceStore. Manages the integration pipeline: each agent runs → merges
 * on DONE → gate runs after all agents finish.
 */
export class MultiAgentRunner {
	private readonly options: MultiAgentRunnerOptions;
	private readonly messageBus = new MessageBus();
	private readonly leaseManager = new LeaseManager();
	private readonly capabilityRegistry = new CapabilityRegistry();
	private readonly worktreeManager: WorktreeManager;
	private readonly runners = new Map<string, AgentRunner>();
	private readonly capabilityRequests: Array<{ agentId: string; capability: string; reason: string }> = [];

	constructor(options: MultiAgentRunnerOptions) {
		this.options = options;
		this.worktreeManager = new WorktreeManager({
			repoPath: options.repoPath,
			integrationBranch: options.integrationBranch,
			scratchPath: options.scratchPath,
		});
	}

	/** Get the shared message bus. */
	getMessageBus(): MessageBus {
		return this.messageBus;
	}

	/** Get the shared lease manager. */
	getLeaseManager(): LeaseManager {
		return this.leaseManager;
	}

	/** Get the capability registry. */
	getCapabilityRegistry(): CapabilityRegistry {
		return this.capabilityRegistry;
	}

	/** Get pending capability requests from agents. */
	getCapabilityRequests(): Array<{ agentId: string; capability: string; reason: string }> {
		return this.capabilityRequests;
	}

	/**
	 * Run multiple agents in parallel, then merge and gate.
	 */
	async run(specs: AgentSpec[]): Promise<MultiAgentResult> {
		const { traceStore, scratchPath, maxAgents } = this.options;
		const missionId = randomUUID();

		if (maxAgents && specs.length > maxAgents) {
			throw new Error(`Cannot spawn ${specs.length} agents: max is ${maxAgents}`);
		}

		// Register roles in lease manager and capability registry
		for (const spec of specs) {
			this.leaseManager.registerRole(spec.roleName, spec.role.pathScope);
		}
		this.capabilityRegistry.loadCatalog(specs.map((s) => s.role));

		// Create worktrees and agent runners
		const agentIds: string[] = [];
		for (const spec of specs) {
			const agentId = this.capabilityRegistry.nextInstanceId(spec.roleName);
			agentIds.push(agentId);

			// Register in capability registry
			this.capabilityRegistry.register(agentId, spec.roleName, spec.role.capabilities);

			// Create worktree
			const worktree = this.worktreeManager.create(agentId);

			// Emit spawn event
			traceStore.emit("orchestrator", "agent.spawn", {
				agentId,
				roleName: spec.roleName,
				mandate: spec.mandate,
			}, [], missionId);

			// Create runner
			const runner = new AgentRunner({
				agentId,
				role: spec.role,
				mandate: spec.mandate,
				worktreePath: worktree.path,
				leaseManager: this.leaseManager,
				traceStore,
				missionId,
				messageBus: this.messageBus,
				capabilityRegistry: this.capabilityRegistry,
				scratchPath,
				onCapabilityRequest: (capability, reason) => {
					this.capabilityRequests.push({ agentId, capability, reason });
					traceStore.emit("orchestrator", "capability.request", {
						requestedBy: agentId,
						capability,
						reason,
					}, [], missionId);
				},
			});

			this.runners.set(agentId, runner);
		}

		// Run all agents in parallel
		const runPromises = new Map<string, Promise<AgentRunResult>>();
		for (const [agentId, runner] of this.runners) {
			runPromises.set(agentId, runner.run());
		}

		// Wait for all agents to finish
		const agentResults = new Map<string, AgentRunResult>();
		const failedAgents: string[] = [];
		for (const [agentId, promise] of runPromises) {
			const result = await promise;
			agentResults.set(agentId, result);
			if (!result.success) {
				failedAgents.push(agentId);
			}
		}

		// Merge successful agents into integration branch
		const mergeResults = new Map<string, MergeResult>();
		const conflictAgents: string[] = [];
		for (const agentId of agentIds) {
			const agentResult = agentResults.get(agentId)!;
			if (!agentResult.success) {
				continue;
			}

			const mergeResult = this.worktreeManager.merge(agentId);
			mergeResults.set(agentId, mergeResult);

			if (mergeResult.success) {
				traceStore.emit("orchestrator", "git.merge", {
					agentId,
					success: true,
					commitHash: mergeResult.commitHash,
				}, [], missionId);
			} else {
				conflictAgents.push(agentId);
				traceStore.emit("orchestrator", "git.conflict", {
					agentId,
					conflicts: mergeResult.conflicts,
				}, [], missionId);
			}
		}

		// Run verification gate
		let gateResult: GateResult | undefined;
		if (this.options.gateCommand && failedAgents.length === 0 && conflictAgents.length === 0) {
			const gate = VerificationGate.fromString(this.options.gateCommand);
			gateResult = gate.run(this.options.repoPath);

			if (gateResult.passed) {
				traceStore.emit("orchestrator", "gate.pass", { durationMs: gateResult.durationMs }, [], missionId);
			} else {
				traceStore.emit("orchestrator", "gate.fail", {
					failedCommand: gateResult.failedCommand,
					durationMs: gateResult.durationMs,
				}, [], missionId);
			}
		}

		// Cleanup worktrees
		for (const agentId of agentIds) {
			this.worktreeManager.remove(agentId);
			this.capabilityRegistry.deactivate(agentId);
			this.messageBus.unsubscribeAll(agentId);
			this.leaseManager.release(agentId);
		}

		const success =
			failedAgents.length === 0 && conflictAgents.length === 0 && (gateResult?.passed ?? true);

		return {
			missionId,
			agentResults,
			mergeResults,
			gateResult,
			success,
			failedAgents,
			conflictAgents,
		};
	}
}
