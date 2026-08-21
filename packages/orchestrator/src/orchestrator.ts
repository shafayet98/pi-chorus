import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MessageBus, LeaseManager, CapabilityRegistry, RoomManager } from "@pi-chorus/coordination";
import type { RoleDefinition } from "@pi-chorus/coordination";
import { WorktreeManager, VerificationGate } from "@pi-chorus/worktree";
import type { TraceStore } from "@pi-chorus/trace";
import { AgentRunner } from "./agent-runner.ts";
import type { AgentRunResult } from "./agent-runner.ts";
import { RoleCatalog } from "./role-catalog.ts";
import { TaskDecomposer } from "./task-decomposer.ts";
import type { DecompositionPlan, Subtask } from "./task-decomposer.ts";
import type { MissionConfig, Mission, MissionResult, AgentInstance } from "./types.ts";

/**
 * Configuration for the orchestrator's safety caps.
 */
interface OrchestratorCaps {
	maxAgents: number;
	maxRepairRounds: number;
	maxWallTimeMs: number;
	maxSpawnDepth: number;
}

const DEFAULT_CAPS: OrchestratorCaps = {
	maxAgents: 10,
	maxRepairRounds: 3,
	maxWallTimeMs: 30 * 60 * 1000, // 30 minutes
	maxSpawnDepth: 3,
};

/**
 * The orchestrator is the runtime — not a peer agent.
 *
 * It decomposes tasks, spawns agents from the role catalog, manages the mission
 * lifecycle, coordinates integration, and enforces caps.
 *
 * Lifecycle:
 * 1. Load role catalog
 * 2. Decompose mission into subtasks (via LLM or direct)
 * 3. Spawn agents for independent subtasks
 * 4. Wait for agents → merge → run gate
 * 5. On gate failure: route failures back, retry up to maxRepairRounds
 * 6. Handle mid-run capability requests by spawning new agents
 * 7. Enforce caps: max agents, wall time, repair rounds
 */
export class Orchestrator {
	private readonly config: MissionConfig;
	private readonly catalog: RoleCatalog;
	private readonly decomposer: TaskDecomposer;
	private readonly traceStore: TraceStore;
	private readonly caps: OrchestratorCaps;

	private readonly messageBus = new MessageBus();
	private readonly leaseManager = new LeaseManager();
	private readonly capabilityRegistry = new CapabilityRegistry();
	private readonly roomManager: RoomManager;

	private mission: Mission | null = null;
	private worktreeManager: WorktreeManager | null = null;
	private readonly runners = new Map<string, AgentRunner>();
	private readonly capabilityRequests: Array<{ agentId: string; capability: string; reason: string }> = [];
	private spawnDepth = 0;

	constructor(config: MissionConfig, traceStore: TraceStore) {
		this.config = config;
		this.traceStore = traceStore;
		this.catalog = new RoleCatalog(config.catalogPath);
		this.decomposer = new TaskDecomposer(config.decomposerModel ?? "sonnet");
		this.roomManager = new RoomManager(this.messageBus);
		this.caps = {
			maxAgents: config.maxAgents ?? DEFAULT_CAPS.maxAgents,
			maxRepairRounds: config.maxRepairRounds ?? DEFAULT_CAPS.maxRepairRounds,
			maxWallTimeMs: config.maxWallTime ?? DEFAULT_CAPS.maxWallTimeMs,
			maxSpawnDepth: DEFAULT_CAPS.maxSpawnDepth,
		};
	}

	/**
	 * Run a mission end-to-end.
	 *
	 * With a pre-built plan (skips LLM decomposition — useful for tests):
	 *   orchestrator.run(plan)
	 *
	 * Without (uses LLM to decompose):
	 *   orchestrator.run()
	 */
	async run(prebuiltPlan?: DecompositionPlan): Promise<MissionResult> {
		const startTime = Date.now();
		const missionId = randomUUID();

		// 1. Load catalog
		const roles = this.catalog.load();
		this.capabilityRegistry.loadCatalog(roles);
		for (const role of roles) {
			this.leaseManager.registerRole(role.name, role.pathScope);
		}

		// 2. Create mission
		this.mission = {
			id: missionId,
			description: this.config.description,
			status: "planning",
			gateCommands: this.config.gate.split("&&").map((c) => c.trim()),
			startedAt: startTime,
			agents: [],
		};

		this.traceStore.emit("orchestrator", "lifecycle.start", {
			mission: this.config.description,
			missionId,
		}, [], missionId);

		// 3. Set up worktree manager
		const scratchPath = join(this.config.repoPath, ".chorus-scratch");
		if (!existsSync(scratchPath)) {
			mkdirSync(scratchPath, { recursive: true });
		}

		this.worktreeManager = new WorktreeManager({
			repoPath: this.config.repoPath,
			integrationBranch: "integration",
			scratchPath,
		});

		// 4. Decompose task
		let plan: DecompositionPlan;
		if (prebuiltPlan) {
			plan = prebuiltPlan;
		} else {
			plan = await this.decomposer.decompose(this.config.description, roles);
		}

		this.traceStore.emit("orchestrator", "decision.record", {
			type: "decomposition",
			subtasks: plan.subtasks.map((s) => ({ name: s.name, role: s.roleName })),
			notes: plan.notes,
		}, [], missionId);

		// 5. Execute with repair loop
		this.mission.status = "running";
		let repairRound = 0;
		let gatePassed = false;
		let totalTokens = 0;
		const allAgentResults = new Map<string, AgentRunResult>();

		while (repairRound <= this.caps.maxRepairRounds && !gatePassed) {
			// Check wall time
			if (Date.now() - startTime > this.caps.maxWallTimeMs) {
				this.traceStore.emit("orchestrator", "lifecycle.crash", {
					reason: "wall_time_exceeded",
				}, [], missionId);
				break;
			}

			// Determine which subtasks to run this round
			const subtasksToRun = repairRound === 0
				? this.getIndependentSubtasks(plan)
				: plan.subtasks; // On repair, re-run everything (simplified)

			// Spawn agents for subtasks
			const agentPromises = new Map<string, Promise<AgentRunResult>>();
			for (const subtask of subtasksToRun) {
				if (this.capabilityRegistry.getActiveCount() >= this.caps.maxAgents) {
					this.traceStore.emit("orchestrator", "capability.deny", {
						reason: "max_agents_reached",
						subtask: subtask.name,
					}, [], missionId);
					continue;
				}

				const result = this.spawnAgent(subtask, missionId);
				if (result) {
					agentPromises.set(result.agentId, result.promise);
				}
			}

			// Wait for all agents
			for (const [agentId, promise] of agentPromises) {
				const result = await promise;
				allAgentResults.set(agentId, result);
			}

			// Handle mid-run capability requests
			await this.handleCapabilityRequests(missionId);

			// Arbitrate any expired rooms
			this.arbitrateExpiredRooms(missionId);

			// Merge successful agents
			const mergeFailures: string[] = [];
			for (const [agentId, result] of allAgentResults) {
				if (!result.success) continue;

				const worktree = this.worktreeManager.get(agentId);
				if (!worktree) continue;

				const mergeResult = this.worktreeManager.merge(agentId);
				if (mergeResult.success) {
					this.traceStore.emit("orchestrator", "git.merge", {
						agentId,
						success: true,
						commitHash: mergeResult.commitHash,
					}, [], missionId);
				} else {
					mergeFailures.push(agentId);
					this.traceStore.emit("orchestrator", "git.conflict", {
						agentId,
						conflicts: mergeResult.conflicts,
					}, [], missionId);
				}
			}

			// Run verification gate
			if (this.config.gate && mergeFailures.length === 0) {
				const gate = VerificationGate.fromString(this.config.gate);
				const gateResult = gate.run(this.config.repoPath);

				if (gateResult.passed) {
					gatePassed = true;
					this.traceStore.emit("orchestrator", "gate.pass", {
						durationMs: gateResult.durationMs,
					}, [], missionId);
				} else {
					this.traceStore.emit("orchestrator", "gate.fail", {
						failedCommand: gateResult.failedCommand,
						durationMs: gateResult.durationMs,
						repairRound,
					}, [], missionId);
					repairRound++;
				}
			} else if (mergeFailures.length > 0) {
				repairRound++;
			} else {
				// No gate configured — consider it passed
				gatePassed = true;
			}

			// Cleanup worktrees for this round
			for (const agentId of agentPromises.keys()) {
				this.cleanupAgent(agentId);
			}
		}

		// Final status
		this.mission.status = gatePassed ? "succeeded" : "failed";
		this.mission.endedAt = Date.now();

		this.traceStore.emit("orchestrator", "lifecycle.stop", {
			status: this.mission.status,
			repairRounds: repairRound,
			wallTimeMs: Date.now() - startTime,
		}, [], missionId);

		return {
			mission: this.mission,
			gatePassed,
			totalTokens,
			wallTimeMs: Date.now() - startTime,
			repairRounds: repairRound,
		};
	}

	/** Get the current mission. */
	getMission(): Mission | null {
		return this.mission;
	}

	/** Get the message bus (for testing/inspection). */
	getMessageBus(): MessageBus {
		return this.messageBus;
	}

	/** Get the lease manager (for testing/inspection). */
	getLeaseManager(): LeaseManager {
		return this.leaseManager;
	}

	/** Get the capability registry (for testing/inspection). */
	getCapabilityRegistry(): CapabilityRegistry {
		return this.capabilityRegistry;
	}

	/** Get the room manager (for testing/inspection). */
	getRoomManager(): RoomManager {
		return this.roomManager;
	}

	private spawnAgent(
		subtask: Subtask,
		missionId: string,
	): { agentId: string; promise: Promise<AgentRunResult> } | null {
		const role = this.catalog.get(subtask.roleName);
		if (!role) {
			// Try nearest match
			const nearest = this.capabilityRegistry.findNearestRole(subtask.roleName);
			if (!nearest) {
				this.traceStore.emit("orchestrator", "capability.unmatched", {
					roleName: subtask.roleName,
					subtask: subtask.name,
				}, [], missionId);
				return null;
			}
			return this.spawnAgentFromRole(nearest, subtask, missionId);
		}

		return this.spawnAgentFromRole(role, subtask, missionId);
	}

	private spawnAgentFromRole(
		role: RoleDefinition,
		subtask: Subtask,
		missionId: string,
	): { agentId: string; promise: Promise<AgentRunResult> } | null {
		const agentId = this.capabilityRegistry.nextInstanceId(role.name);

		// Register in capability registry
		this.capabilityRegistry.register(agentId, role.name, role.capabilities);

		// Create worktree
		const worktree = this.worktreeManager!.create(agentId);

		// Track as agent instance
		const instance: AgentInstance = {
			id: agentId,
			roleName: role.name,
			role,
			status: "spawning",
			mandate: subtask.mandate,
			spawnedBy: "orchestrator",
			worktreePath: worktree.path,
		};
		this.mission!.agents.push(instance);

		this.traceStore.emit("orchestrator", "agent.spawn", {
			agentId,
			roleName: role.name,
			mandate: subtask.mandate,
			roleVersion: role.name, // In a real system, this would be a version hash
		}, [], missionId);

		// Create runner
		const runner = new AgentRunner({
			agentId,
			role,
			mandate: subtask.mandate,
			worktreePath: worktree.path,
			leaseManager: this.leaseManager,
			traceStore: this.traceStore,
			missionId,
			messageBus: this.messageBus,
			capabilityRegistry: this.capabilityRegistry,
			roomManager: this.roomManager,
			initialDecisions: this.roomManager.getAllDecisions(),
			scratchPath: this.worktreeManager!.getScratchPath(),
			onCapabilityRequest: (capability, reason) => {
				this.capabilityRequests.push({ agentId, capability, reason });
			},
		});

		this.runners.set(agentId, runner);
		instance.status = "active";

		const promise = runner.run().then((result) => {
			instance.status = result.success ? "done" : "failed";
			return result;
		});

		return { agentId, promise };
	}

	private async handleCapabilityRequests(missionId: string): Promise<void> {
		while (this.capabilityRequests.length > 0) {
			const request = this.capabilityRequests.shift()!;

			// Check if someone already provides this
			const existing = this.capabilityRegistry.findByCapability(request.capability);
			if (existing) continue;

			// Check spawn caps
			if (this.capabilityRegistry.getActiveCount() >= this.caps.maxAgents) {
				this.traceStore.emit("orchestrator", "capability.deny", {
					reason: "max_agents_reached",
					capability: request.capability,
				}, [], missionId);
				continue;
			}

			// Find a matching role
			const role = this.capabilityRegistry.findRoleByCapability(request.capability);
			if (!role) {
				this.traceStore.emit("orchestrator", "capability.unmatched", {
					capability: request.capability,
					requestedBy: request.agentId,
				}, [], missionId);
				continue;
			}

			// Spawn the agent
			const subtask: Subtask = {
				name: `capability-${request.capability}`,
				roleName: role.name,
				mandate: `Provide ${request.capability} capability. Reason: ${request.reason}`,
				dependsOn: [],
			};

			const spawned = this.spawnAgentFromRole(role, subtask, missionId);
			if (spawned) {
				// Let the requesting agent know
				this.messageBus.send("orchestrator", request.agentId, "INFO", {
					content: `Spawned ${spawned.agentId} (${role.name}) to provide "${request.capability}".`,
				}, this.traceStore.clockFor("orchestrator").tick());

				// Wait for the new agent
				const result = await spawned.promise;
				if (!result.success) {
					this.messageBus.send("orchestrator", request.agentId, "INFO", {
						content: `Agent ${spawned.agentId} failed: ${result.error}`,
					}, this.traceStore.clockFor("orchestrator").tick());
				}
			}
		}
	}

	/**
	 * Arbitrate rooms that hit their turn budget.
	 * The orchestrator steps in, makes the decision, and writes the record.
	 */
	private arbitrateExpiredRooms(missionId: string): void {
		const expired = this.roomManager.getExpiredRooms();
		for (const room of expired) {
			// Orchestrator makes the decision based on the room context
			const decision = this.roomManager.resolve(
				room.id,
				`Orchestrator arbitration: proceeding with the last proposal for "${room.question}".`,
				`Room "${room.topic}" exhausted its turn budget (${room.turnBudget} turns). The orchestrator is arbitrating to unblock progress.`,
				[], // No dissents recorded in automated arbitration
			);

			this.traceStore.emit("orchestrator", "room.resolve", {
				roomId: room.id,
				decisionId: decision.id,
				arbitrated: true,
			}, [], missionId);

			this.traceStore.emit("orchestrator", "decision.record", {
				decisionId: decision.id,
				question: room.question,
				decision: decision.decision,
				arbitrated: true,
				participants: room.members,
			}, [], missionId);

			// Notify all room members
			for (const member of room.members) {
				this.messageBus.send("orchestrator", member, "INFO", {
					content: `Room "${room.topic}" was arbitrated by the orchestrator. Decision: ${decision.decision}. Use read_decision("${decision.id}") for details.`,
				}, this.traceStore.clockFor("orchestrator").tick());
			}
		}
	}

	private getIndependentSubtasks(plan: DecompositionPlan): Subtask[] {
		// Return subtasks with no dependencies (can run in parallel)
		return plan.subtasks.filter((s) => s.dependsOn.length === 0);
	}

	private cleanupAgent(agentId: string): void {
		this.worktreeManager?.remove(agentId);
		this.capabilityRegistry.deactivate(agentId);
		this.messageBus.unsubscribeAll(agentId);
		this.leaseManager.release(agentId);
		this.runners.delete(agentId);
	}
}
