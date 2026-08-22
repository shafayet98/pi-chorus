import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MergeResult, Worktree, WorktreeManagerOptions } from "./types.ts";

/**
 * Manages git worktrees for agent isolation.
 * Each agent gets a private checkout. Integration is explicit via merge.
 */
export class WorktreeManager {
	private readonly repoPath: string;
	private readonly integrationBranch: string;
	private readonly scratchPath: string;
	private readonly worktrees = new Map<string, Worktree>();

	constructor(options: WorktreeManagerOptions) {
		this.repoPath = options.repoPath;
		this.integrationBranch = options.integrationBranch;
		this.scratchPath = options.scratchPath;

		if (!existsSync(this.scratchPath)) {
			mkdirSync(this.scratchPath, { recursive: true });
		}
	}

	/** Create a new worktree for an agent. */
	create(agentId: string): Worktree {
		const branch = `chorus/${agentId}`;
		const worktreePath = join(this.repoPath, ".worktrees", agentId);

		// Delete existing branch if leftover from a previous run
		try {
			this.git(`branch -D ${branch}`);
		} catch {
			// Branch doesn't exist — expected
		}

		// Remove existing worktree path if leftover
		if (existsSync(worktreePath)) {
			try {
				this.git(`worktree remove ${worktreePath} --force`);
			} catch {
				rmSync(worktreePath, { recursive: true, force: true });
			}
			this.git("worktree prune");
		}

		// Create branch from integration branch
		this.git(`branch ${branch} ${this.integrationBranch}`);

		// Create worktree
		this.git(`worktree add ${worktreePath} ${branch}`);

		const worktree: Worktree = {
			agentId,
			path: worktreePath,
			branch,
			active: true,
		};
		this.worktrees.set(agentId, worktree);
		return worktree;
	}

	/** Merge an agent's worktree into the integration branch. */
	merge(agentId: string): MergeResult {
		const worktree = this.worktrees.get(agentId);
		if (!worktree) {
			throw new Error(`No worktree found for agent ${agentId}`);
		}

		try {
			// Switch to integration branch in the main repo
			this.git(`checkout ${this.integrationBranch}`);

			// Attempt merge
			this.git(`merge --no-ff ${worktree.branch} -m "Merge ${agentId} work"`);

			const commitHash = this.git("rev-parse HEAD").trim();
			return { success: true, conflicts: [], commitHash };
		} catch (e: any) {
			// Check for merge conflicts
			const statusOutput = this.git("status --porcelain");
			const conflicts = statusOutput
				.split("\n")
				.filter((line) => line.startsWith("UU ") || line.startsWith("AA "))
				.map((line) => line.slice(3).trim());

			// Abort the failed merge
			try {
				this.git("merge --abort");
			} catch {
				// merge --abort can fail if there's nothing to abort
			}

			return { success: false, conflicts };
		}
	}

	/** Remove an agent's worktree and branch. */
	remove(agentId: string): void {
		const worktree = this.worktrees.get(agentId);
		if (!worktree) return;

		try {
			this.git(`worktree remove ${worktree.path} --force`);
		} catch {
			// Worktree might already be gone
			if (existsSync(worktree.path)) {
				rmSync(worktree.path, { recursive: true, force: true });
			}
			try {
				this.git("worktree prune");
			} catch {
				// Ignore prune errors
			}
		}

		try {
			this.git(`branch -D ${worktree.branch}`);
		} catch {
			// Branch might already be gone
		}

		this.worktrees.delete(agentId);
	}

	/** Get the worktree for an agent. */
	get(agentId: string): Worktree | undefined {
		return this.worktrees.get(agentId);
	}

	/** List all active worktrees. */
	list(): Worktree[] {
		return Array.from(this.worktrees.values()).filter((w) => w.active);
	}

	/** Get the scratch space path. Agents use this for pre-merge sharing. */
	getScratchPath(): string {
		return this.scratchPath;
	}

	private git(args: string): string {
		return execSync(`git ${args}`, {
			cwd: this.repoPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	}
}
