import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TraceStore, createInMemoryDatabase } from "@pi-chorus/trace";
import type { RoleDefinition } from "@pi-chorus/coordination";
import { TaskDecomposer } from "../src/task-decomposer.ts";
import type { DecompositionPlan, Subtask } from "../src/task-decomposer.ts";
import { Watchdog } from "../src/watchdog.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { RoleCatalog } from "../src/role-catalog.ts";

const frontendRole: RoleDefinition = {
	name: "frontend",
	description: "Frontend development",
	capabilities: ["frontend", "react"],
	systemPrompt: "You are a frontend developer.",
	model: "sonnet",
	tools: ["read", "write", "edit", "bash"],
	pathScope: ["src/components/**", "src/pages/**"],
};

const backendRole: RoleDefinition = {
	name: "backend",
	description: "Backend development",
	capabilities: ["backend", "api"],
	systemPrompt: "You are a backend developer.",
	model: "sonnet",
	tools: ["read", "write", "edit", "bash"],
	pathScope: ["src/api/**", "src/services/**"],
};

const testingRole: RoleDefinition = {
	name: "testing",
	description: "Test writing",
	capabilities: ["testing", "tests"],
	systemPrompt: "You are a test writer.",
	model: "sonnet",
	tools: ["read", "write", "bash"],
	pathScope: ["test/**"],
};

describe("TaskDecomposer", () => {
	it("should create a direct plan without LLM", () => {
		const decomposer = new TaskDecomposer();
		const plan = decomposer.decomposeDirect(
			"Build a todo app",
			[
				{
					name: "build-api",
					roleName: "backend",
					mandate: "Create REST API endpoints for todos",
					dependsOn: [],
				},
				{
					name: "build-ui",
					roleName: "frontend",
					mandate: "Create React components for the todo list",
					dependsOn: ["build-api"],
				},
			],
			"API first, then UI",
		);

		expect(plan.mission).toBe("Build a todo app");
		expect(plan.subtasks).toHaveLength(2);
		expect(plan.subtasks[0].roleName).toBe("backend");
		expect(plan.subtasks[1].dependsOn).toContain("build-api");
		expect(plan.notes).toBe("API first, then UI");
	});

	it("should identify independent subtasks", () => {
		const plan: DecompositionPlan = {
			mission: "Build an app",
			subtasks: [
				{ name: "api", roleName: "backend", mandate: "Build API", dependsOn: [] },
				{ name: "ui", roleName: "frontend", mandate: "Build UI", dependsOn: [] },
				{ name: "tests", roleName: "testing", mandate: "Write tests", dependsOn: ["api", "ui"] },
			],
			notes: "",
		};

		const independent = plan.subtasks.filter((s) => s.dependsOn.length === 0);
		expect(independent).toHaveLength(2);
		expect(independent.map((s) => s.name)).toContain("api");
		expect(independent.map((s) => s.name)).toContain("ui");
	});
});

describe("Watchdog", () => {
	it("should detect a simple two-agent deadlock", () => {
		const watchdog = new Watchdog();

		// A waits for B, B waits for A
		watchdog.addWait("frontend#1", "backend#1");
		watchdog.addWait("backend#1", "frontend#1");

		const deadlocks = watchdog.detectDeadlocks();
		expect(deadlocks).toHaveLength(1);
		expect(deadlocks[0].cycle).toContain("frontend#1");
		expect(deadlocks[0].cycle).toContain("backend#1");
	});

	it("should identify the youngest agent in a cycle", () => {
		const watchdog = new Watchdog();

		watchdog.addWait("frontend#1", "frontend#3");
		watchdog.addWait("frontend#3", "frontend#2");
		watchdog.addWait("frontend#2", "frontend#1");

		const deadlocks = watchdog.detectDeadlocks();
		expect(deadlocks).toHaveLength(1);
		expect(deadlocks[0].youngest).toBe("frontend#3");
	});

	it("should not report deadlocks when there are none", () => {
		const watchdog = new Watchdog();

		// Linear chain: A → B → C (no cycle)
		watchdog.addWait("a#1", "b#1");
		watchdog.addWait("b#1", "c#1");

		const deadlocks = watchdog.detectDeadlocks();
		expect(deadlocks).toHaveLength(0);
	});

	it("should detect timed-out waits", () => {
		const watchdog = new Watchdog(100); // 100ms timeout

		watchdog.addWait("a#1", "b#1");

		// Immediately: no timeout
		expect(watchdog.getTimedOutWaits()).toHaveLength(0);

		// Simulate passage of time by modifying the edge
		const edges = watchdog.getWaitEdges();
		edges[0].since = Date.now() - 200; // 200ms ago

		expect(watchdog.getTimedOutWaits()).toHaveLength(1);
	});

	it("should remove agents cleanly", () => {
		const watchdog = new Watchdog();

		watchdog.addWait("a#1", "b#1");
		watchdog.addWait("c#1", "a#1");
		watchdog.recordActivity("a#1");

		watchdog.removeAgent("a#1");

		expect(watchdog.getWaitEdges()).toHaveLength(0); // Both edges involving a#1 removed
		expect(watchdog.getAllHealth().find((h) => h.agentId === "a#1")).toBeUndefined();
	});

	it("should track agent health", () => {
		const watchdog = new Watchdog();

		watchdog.recordActivity("frontend#1");
		watchdog.recordActivity("backend#1");

		const health = watchdog.getAllHealth();
		expect(health).toHaveLength(2);
		expect(health.every((h) => h.status === "active")).toBe(true);

		watchdog.addWait("frontend#1", "backend#1");
		const updated = watchdog.getAllHealth();
		const frontendHealth = updated.find((h) => h.agentId === "frontend#1");
		expect(frontendHealth!.status).toBe("waiting");
	});

	it("should detect stale agents", () => {
		const watchdog = new Watchdog(100); // 100ms timeout

		watchdog.recordActivity("a#1");

		// Simulate staleness
		const health = watchdog.getAllHealth();
		health[0].lastActivityAt = Date.now() - 200;

		const stale = watchdog.getStaleAgents();
		expect(stale).toHaveLength(1);
		expect(stale[0].agentId).toBe("a#1");
	});
});

describe("Role Catalog", () => {
	let catalogDir: string;

	beforeEach(() => {
		catalogDir = mkdtempSync(join(tmpdir(), "pi-chorus-catalog-"));
		writeFileSync(join(catalogDir, "frontend.yaml"), `
name: frontend
description: "Frontend development"
capabilities: [frontend, react]
system_prompt: "You are a frontend developer."
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - src/components/**
  - src/pages/**
`);
		writeFileSync(join(catalogDir, "backend.yaml"), `
name: backend
description: "Backend development"
capabilities: [backend, api]
system_prompt: "You are a backend developer."
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - src/api/**
  - src/services/**
`);
	});

	afterEach(() => {
		rmSync(catalogDir, { recursive: true, force: true });
	});

	it("should load multiple roles from catalog directory", () => {
		const catalog = new RoleCatalog(catalogDir);
		const roles = catalog.load();

		expect(roles).toHaveLength(2);
		expect(roles.map((r) => r.name).sort()).toEqual(["backend", "frontend"]);
	});

	it("should get individual roles by name", () => {
		const catalog = new RoleCatalog(catalogDir);
		catalog.load();

		const frontend = catalog.get("frontend");
		expect(frontend).toBeDefined();
		expect(frontend!.capabilities).toContain("react");

		const missing = catalog.get("nonexistent");
		expect(missing).toBeUndefined();
	});
});

describe("Orchestrator with pre-built plan", () => {
	let repoPath: string;
	let catalogDir: string;
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		// Create a test repo
		repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-orch-"));
		execSync("git init", { cwd: repoPath });
		execSync("git config user.email 'test@test.com'", { cwd: repoPath });
		execSync("git config user.name 'Test'", { cwd: repoPath });
		writeFileSync(join(repoPath, "README.md"), "# Test\n");
		execSync("git add . && git commit -m 'init'", { cwd: repoPath });
		execSync("git checkout -b integration", { cwd: repoPath });
		execSync("git checkout main", { cwd: repoPath });

		// Create role catalog
		catalogDir = mkdtempSync(join(tmpdir(), "pi-chorus-orch-catalog-"));
		writeFileSync(join(catalogDir, "frontend.yaml"), `
name: frontend
description: "Frontend development"
capabilities: [frontend, react]
system_prompt: "You are a frontend developer."
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - src/components/**
`);
		writeFileSync(join(catalogDir, "backend.yaml"), `
name: backend
description: "Backend development"
capabilities: [backend, api]
system_prompt: "You are a backend developer."
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - src/api/**
`);

		// Create trace store
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-orch-trace-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
	});

	afterEach(() => {
		try { execSync("git worktree prune", { cwd: repoPath }); } catch {}
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(catalogDir, { recursive: true, force: true });
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should emit decomposition and spawn events with a pre-built plan", async () => {
		const orchestrator = new Orchestrator({
			description: "Build a simple app",
			gate: "test -f README.md", // Simple gate that passes
			repoPath,
			catalogPath: catalogDir,
			maxAgents: 5,
		}, traceStore);

		const plan: DecompositionPlan = {
			mission: "Build a simple app",
			subtasks: [], // No subtasks — just test the orchestrator lifecycle
			notes: "Empty plan for testing",
		};

		const result = await orchestrator.run(plan);

		// Should succeed with no subtasks (gate passes on existing README)
		expect(result.mission.status).toBe("succeeded");
		expect(result.gatePassed).toBe(true);

		// Verify trace events
		const events = traceStore.getEventsByMission(result.mission.id);
		const kinds = events.map((e) => e.kind);

		expect(kinds).toContain("lifecycle.start");
		expect(kinds).toContain("decision.record"); // Decomposition plan
		expect(kinds).toContain("gate.pass");
		expect(kinds).toContain("lifecycle.stop");
	});

	it("should enforce max agents cap", async () => {
		const orchestrator = new Orchestrator({
			description: "Build an app",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
			maxAgents: 1, // Only allow 1 agent
		}, traceStore);

		const plan: DecompositionPlan = {
			mission: "Build an app",
			subtasks: [
				{ name: "api", roleName: "backend", mandate: "Build API", dependsOn: [] },
				{ name: "ui", roleName: "frontend", mandate: "Build UI", dependsOn: [] },
			],
			notes: "",
		};

		const result = await orchestrator.run(plan);

		// Should only have spawned 1 agent (second denied)
		const events = traceStore.getEventsByMission(result.mission.id);
		const spawnEvents = events.filter((e) => e.kind === "agent.spawn");
		const denyEvents = events.filter((e) => e.kind === "capability.deny");

		expect(spawnEvents.length).toBe(1);
		expect(denyEvents.length).toBe(1);
	});

	it("should emit capability.unmatched for unknown roles", async () => {
		const orchestrator = new Orchestrator({
			description: "Build an app",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
		}, traceStore);

		const plan: DecompositionPlan = {
			mission: "Build an app",
			subtasks: [
				{ name: "devops", roleName: "devops-engineer", mandate: "Set up CI/CD", dependsOn: [] },
			],
			notes: "",
		};

		const result = await orchestrator.run(plan);

		const events = traceStore.getEventsByMission(result.mission.id);
		const unmatchedEvents = events.filter((e) => e.kind === "capability.unmatched");
		expect(unmatchedEvents.length).toBe(1);
	});

	it("should report mission status correctly", async () => {
		const orchestrator = new Orchestrator({
			description: "Test mission",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
		}, traceStore);

		// Before run
		expect(orchestrator.getMission()).toBeNull();

		const result = await orchestrator.run({
			mission: "Test",
			subtasks: [],
			notes: "",
		});

		// After run
		const mission = orchestrator.getMission();
		expect(mission).not.toBeNull();
		expect(mission!.status).toBe("succeeded");
		expect(mission!.endedAt).toBeDefined();
		expect(result.wallTimeMs).toBeGreaterThan(0);
	});
});

describe("Orchestrator caps enforcement", () => {
	it("should respect wall time limit", async () => {
		const repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-caps-"));
		const catalogDir = mkdtempSync(join(tmpdir(), "pi-chorus-caps-catalog-"));
		const contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-caps-trace-"));

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

		const traceStore = new TraceStore(createInMemoryDatabase(), contentDir);

		const orchestrator = new Orchestrator({
			description: "Test",
			gate: "false", // Gate always fails — triggers repair loop
			repoPath,
			catalogPath: catalogDir,
			maxRepairRounds: 100, // High limit — wall time should kick in first
			maxWallTime: 1, // 1ms wall time limit — will trigger immediately
		}, traceStore);

		const result = await orchestrator.run({
			mission: "Test",
			subtasks: [],
			notes: "",
		});

		// Mission should fail due to wall time, not succeed
		expect(result.mission.status).toBe("failed");

		try { execSync("git worktree prune", { cwd: repoPath }); } catch {}
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(catalogDir, { recursive: true, force: true });
		rmSync(contentDir, { recursive: true, force: true });
	});
});
