import type { DecompositionPlan } from "./task-decomposer.ts";
import type { MergeResult } from "@pi-chorus/worktree";
import { createInterface } from "node:readline";

/**
 * Human-in-the-loop approval interface.
 *
 * Default: you approve the final merge and arbitrate rooms that hit their
 * turn budget. Fully autonomous available via AutoApprover.
 */
export interface Approver {
	/** Approve the decomposition plan before agents are spawned. */
	approvePlan(plan: DecompositionPlan): Promise<boolean>;
	/** Approve the final merge to the integration branch. */
	approveMerge(agentId: string, mergeResult: MergeResult): Promise<boolean>;
	/** Called when a mission completes — show summary. */
	onMissionComplete(summary: MissionSummary): void;
}

export interface MissionSummary {
	missionId: string;
	status: "succeeded" | "failed";
	agentCount: number;
	wallTimeMs: number;
	totalTokens: number;
	repairRounds: number;
	gatePassed: boolean;
}

/**
 * Auto-approves everything. Used when --auto flag is set or in tests.
 */
export class AutoApprover implements Approver {
	async approvePlan(_plan: DecompositionPlan): Promise<boolean> {
		return true;
	}
	async approveMerge(_agentId: string, _mergeResult: MergeResult): Promise<boolean> {
		return true;
	}
	onMissionComplete(_summary: MissionSummary): void {}
}

/**
 * Interactive CLI approver. Prompts the user for decisions.
 */
export class InteractiveApprover implements Approver {
	async approvePlan(plan: DecompositionPlan): Promise<boolean> {
		console.log("\n--- Decomposition Plan ---");
		console.log(`Mission: ${plan.mission}`);
		console.log(`Subtasks (${plan.subtasks.length}):`);
		for (const s of plan.subtasks) {
			const deps = s.dependsOn.length > 0 ? ` (depends on: ${s.dependsOn.join(", ")})` : "";
			console.log(`  - [${s.roleName}] ${s.name}: ${s.mandate.slice(0, 80)}${s.mandate.length > 80 ? "..." : ""}${deps}`);
		}
		if (plan.notes) {
			console.log(`Notes: ${plan.notes}`);
		}
		console.log("");

		return this.confirm("Approve this plan and spawn agents?");
	}

	async approveMerge(agentId: string, mergeResult: MergeResult): Promise<boolean> {
		if (!mergeResult.success) {
			console.log(`\nMerge conflict for ${agentId}:`);
			console.log(`  Conflicting files: ${mergeResult.conflicts.join(", ")}`);
			return this.confirm("Skip this merge and continue?");
		}

		console.log(`\nAgent ${agentId} completed. Merge commit: ${mergeResult.commitHash?.slice(0, 8)}`);
		return this.confirm("Approve merge?");
	}

	onMissionComplete(summary: MissionSummary): void {
		console.log("\n--- Mission Complete ---");
		console.log(`Status: ${summary.status}`);
		console.log(`Agents: ${summary.agentCount}`);
		console.log(`Time: ${(summary.wallTimeMs / 1000).toFixed(1)}s`);
		console.log(`Tokens: ${summary.totalTokens}`);
		console.log(`Gate: ${summary.gatePassed ? "PASSED" : "FAILED"}`);
		if (summary.repairRounds > 0) {
			console.log(`Repair rounds: ${summary.repairRounds}`);
		}
	}

	private confirm(question: string): Promise<boolean> {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		return new Promise((resolve) => {
			rl.question(`${question} [Y/n] `, (answer) => {
				rl.close();
				const normalized = answer.trim().toLowerCase();
				resolve(normalized === "" || normalized === "y" || normalized === "yes");
			});
		});
	}
}
