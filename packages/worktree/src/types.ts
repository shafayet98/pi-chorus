export interface Worktree {
	/** Unique ID, matches the agent instance ID */
	agentId: string;
	/** Filesystem path to the worktree */
	path: string;
	/** Branch name for this worktree */
	branch: string;
	/** Whether this worktree is still active */
	active: boolean;
}

export interface MergeResult {
	success: boolean;
	/** Files that had merge conflicts */
	conflicts: string[];
	/** Commit hash of the merge, if successful */
	commitHash?: string;
}

export interface GateResult {
	passed: boolean;
	/** Which gate command failed, if any */
	failedCommand?: string;
	/** stdout + stderr from the gate run */
	output: string;
	/** How long the gate took in ms */
	durationMs: number;
}

export interface WorktreeManagerOptions {
	/** Path to the main repository */
	repoPath: string;
	/** Name of the integration branch */
	integrationBranch: string;
	/** Path for shared scratch space */
	scratchPath: string;
}
