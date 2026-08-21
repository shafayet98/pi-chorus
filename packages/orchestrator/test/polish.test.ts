import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TraceStore, createInMemoryDatabase } from "@pi-chorus/trace";
import type { MissionRecord } from "@pi-chorus/trace";
import { AutoApprover } from "../src/approval.ts";
import type { Approver, MissionSummary } from "../src/approval.ts";
import type { DecompositionPlan } from "../src/task-decomposer.ts";
import type { MergeResult } from "@pi-chorus/worktree";
import { Orchestrator } from "../src/orchestrator.ts";

// Test approver that records calls and can reject
class TestApprover implements Approver {
	planCalls: DecompositionPlan[] = [];
	mergeCalls: Array<{ agentId: string; mergeResult: MergeResult }> = [];
	completeCalls: MissionSummary[] = [];
	shouldApprovePlan = true;
	shouldApproveMerge = true;

	async approvePlan(plan: DecompositionPlan): Promise<boolean> {
		this.planCalls.push(plan);
		return this.shouldApprovePlan;
	}
	async approveMerge(agentId: string, mergeResult: MergeResult): Promise<boolean> {
		this.mergeCalls.push({ agentId, mergeResult });
		return this.shouldApproveMerge;
	}
	onMissionComplete(summary: MissionSummary): void {
		this.completeCalls.push(summary);
	}
}

describe("Approval system", () => {
	it("AutoApprover should approve everything", async () => {
		const approver = new AutoApprover();
		expect(await approver.approvePlan({ mission: "test", subtasks: [], notes: "" })).toBe(true);
		expect(await approver.approveMerge("agent#1", { success: true, conflicts: [] })).toBe(true);
	});

	it("TestApprover should record plan approval calls", async () => {
		const approver = new TestApprover();
		const plan: DecompositionPlan = {
			mission: "Build an app",
			subtasks: [{ name: "api", roleName: "backend", mandate: "Build API", dependsOn: [] }],
			notes: "test",
		};

		await approver.approvePlan(plan);
		expect(approver.planCalls).toHaveLength(1);
		expect(approver.planCalls[0].mission).toBe("Build an app");
	});

	it("TestApprover should reject plans when configured", async () => {
		const approver = new TestApprover();
		approver.shouldApprovePlan = false;
		expect(await approver.approvePlan({ mission: "x", subtasks: [], notes: "" })).toBe(false);
	});
});

describe("Orchestrator with approval", () => {
	let repoPath: string;
	let catalogDir: string;
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-polish-"));
		execSync("git init", { cwd: repoPath });
		execSync("git config user.email 'test@test.com'", { cwd: repoPath });
		execSync("git config user.name 'Test'", { cwd: repoPath });
		writeFileSync(join(repoPath, "README.md"), "# Test\n");
		execSync("git add . && git commit -m 'init'", { cwd: repoPath });
		execSync("git checkout -b integration", { cwd: repoPath });
		execSync("git checkout main", { cwd: repoPath });

		catalogDir = mkdtempSync(join(tmpdir(), "pi-chorus-polish-catalog-"));
		writeFileSync(join(catalogDir, "backend.yaml"), `
name: backend
description: "Backend"
capabilities: [backend]
system_prompt: "test"
model: sonnet
tools: [read]
path_scope: [src/**]
`);

		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-polish-trace-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
	});

	afterEach(() => {
		try { execSync("git worktree prune", { cwd: repoPath }); } catch {}
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(catalogDir, { recursive: true, force: true });
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should abort mission when plan is rejected", async () => {
		const approver = new TestApprover();
		approver.shouldApprovePlan = false;

		const orchestrator = new Orchestrator({
			description: "Test rejection",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
		}, traceStore, approver);

		const result = await orchestrator.run({
			mission: "Test",
			subtasks: [{ name: "api", roleName: "backend", mandate: "Build", dependsOn: [] }],
			notes: "",
		});

		expect(result.mission.status).toBe("aborted");
		expect(approver.planCalls).toHaveLength(1);

		// Verify abort trace event
		const events = traceStore.getEventsByMission(result.mission.id);
		const stopEvent = events.find((e) => e.kind === "lifecycle.stop");
		expect(stopEvent).toBeDefined();
		const payload = traceStore.getPayload(stopEvent!.payloadHash) as any;
		expect(payload.reason).toBe("plan_rejected");
	});

	it("should notify approver on mission completion", async () => {
		const approver = new TestApprover();

		const orchestrator = new Orchestrator({
			description: "Test completion",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
		}, traceStore, approver);

		await orchestrator.run({ mission: "Test", subtasks: [], notes: "" });

		expect(approver.completeCalls).toHaveLength(1);
		expect(approver.completeCalls[0].status).toBe("succeeded");
		expect(approver.completeCalls[0].missionId).toBeDefined();
	});
});

describe("Mission persistence", () => {
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-persist-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
	});

	afterEach(() => {
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should save and retrieve a mission record", () => {
		const mission: MissionRecord = {
			id: "mission-001",
			description: "Build a todo app",
			status: "succeeded",
			startedAt: Date.now() - 60000,
			endedAt: Date.now(),
			agentCount: 3,
			totalTokens: 15000,
			gatePassed: true,
		};

		traceStore.saveMission(mission);

		const retrieved = traceStore.getMission("mission-001");
		expect(retrieved).not.toBeNull();
		expect(retrieved!.description).toBe("Build a todo app");
		expect(retrieved!.status).toBe("succeeded");
		expect(retrieved!.agentCount).toBe(3);
		expect(retrieved!.gatePassed).toBe(true);
	});

	it("should list missions in reverse chronological order", () => {
		traceStore.saveMission({
			id: "m1", description: "First", status: "succeeded",
			startedAt: 1000, endedAt: 2000, agentCount: 1, totalTokens: 100, gatePassed: true,
		});
		traceStore.saveMission({
			id: "m2", description: "Second", status: "failed",
			startedAt: 3000, endedAt: 4000, agentCount: 2, totalTokens: 200, gatePassed: false,
		});

		const missions = traceStore.listMissions();
		expect(missions).toHaveLength(2);
		expect(missions[0].id).toBe("m2"); // Most recent first
		expect(missions[1].id).toBe("m1");
	});

	it("should return null for unknown mission", () => {
		expect(traceStore.getMission("nonexistent")).toBeNull();
	});

	it("should persist missions from orchestrator runs", async () => {
		const repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-persist-orch-"));
		const catalogDir = mkdtempSync(join(tmpdir(), "pi-chorus-persist-catalog-"));

		execSync("git init", { cwd: repoPath });
		execSync("git config user.email 'test@test.com'", { cwd: repoPath });
		execSync("git config user.name 'Test'", { cwd: repoPath });
		writeFileSync(join(repoPath, "README.md"), "# Test\n");
		execSync("git add . && git commit -m 'init'", { cwd: repoPath });
		execSync("git checkout -b integration", { cwd: repoPath });
		execSync("git checkout main", { cwd: repoPath });

		writeFileSync(join(catalogDir, "backend.yaml"), `
name: backend
description: "Backend"
capabilities: [backend]
system_prompt: "test"
model: sonnet
tools: [read]
path_scope: [src/**]
`);

		const orchestrator = new Orchestrator({
			description: "Persistence test mission",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
		}, traceStore);

		const result = await orchestrator.run({ mission: "Test", subtasks: [], notes: "" });

		// Mission should be persisted
		const missions = traceStore.listMissions();
		expect(missions).toHaveLength(1);
		expect(missions[0].id).toBe(result.mission.id);
		expect(missions[0].description).toBe("Persistence test mission");
		expect(missions[0].status).toBe("succeeded");

		try { execSync("git worktree prune", { cwd: repoPath }); } catch {}
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(catalogDir, { recursive: true, force: true });
	});
});
