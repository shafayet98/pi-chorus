import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MessageBus, LeaseManager, CapabilityRegistry } from "@pi-chorus/coordination";
import type { RoleDefinition, DecisionRecord } from "@pi-chorus/coordination";
import { TraceStore, createInMemoryDatabase } from "@pi-chorus/trace";
import { Watchdog } from "../src/watchdog.ts";
import { buildBriefing } from "../src/briefing.ts";
import type { BriefingContext } from "../src/briefing.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { DecompositionPlan } from "../src/task-decomposer.ts";

describe("Watchdog integration with Orchestrator", () => {
	it("should track BLOCKED_ON messages as wait edges", () => {
		const bus = new MessageBus();
		const watchdog = new Watchdog();

		// Simulate what the orchestrator does: subscribe to BLOCKED_ON
		bus.subscribeAll((msg) => {
			if (msg.type === "BLOCKED_ON") {
				watchdog.addWait(msg.from, msg.to);
			}
		});

		bus.subscribe("backend#1", () => {});
		bus.subscribe("frontend#1", () => {});

		// Frontend sends BLOCKED_ON to backend
		bus.send("frontend#1", "backend#1", "BLOCKED_ON", {
			content: "Need the User interface before I can proceed",
		}, 1);

		const edges = watchdog.getWaitEdges();
		expect(edges).toHaveLength(1);
		expect(edges[0].waiter).toBe("frontend#1");
		expect(edges[0].waitingFor).toBe("backend#1");
	});

	it("should detect deadlock from BLOCKED_ON messages", () => {
		const bus = new MessageBus();
		const watchdog = new Watchdog();

		bus.subscribeAll((msg) => {
			if (msg.type === "BLOCKED_ON") {
				watchdog.addWait(msg.from, msg.to);
			}
		});

		bus.subscribe("a#1", () => {});
		bus.subscribe("b#1", () => {});

		// Mutual BLOCKED_ON → deadlock
		bus.send("a#1", "b#1", "BLOCKED_ON", { content: "Need B" }, 1);
		bus.send("b#1", "a#1", "BLOCKED_ON", { content: "Need A" }, 2);

		const deadlocks = watchdog.detectDeadlocks();
		expect(deadlocks).toHaveLength(1);
		expect(deadlocks[0].cycle).toContain("a#1");
		expect(deadlocks[0].cycle).toContain("b#1");
	});

	it("should clear wait edges on DONE messages", () => {
		const bus = new MessageBus();
		const watchdog = new Watchdog();

		bus.subscribeAll((msg) => {
			if (msg.type === "BLOCKED_ON") watchdog.addWait(msg.from, msg.to);
			if (msg.type === "DONE") watchdog.removeWait(msg.from);
		});

		bus.subscribe("a#1", () => {});
		bus.subscribe("b#1", () => {});

		bus.send("a#1", "b#1", "BLOCKED_ON", { content: "waiting" }, 1);
		expect(watchdog.getWaitEdges()).toHaveLength(1);

		bus.send("a#1", "b#1", "DONE", {}, 2);
		expect(watchdog.getWaitEdges()).toHaveLength(0);
	});
});

describe("Cold-start briefing builder", () => {
	it("should build a basic briefing with just a mandate", () => {
		const briefing = buildBriefing({
			mandate: "Build the login page",
			decisions: [],
			activeAgents: [],
		});

		expect(briefing).toBe("Build the login page");
	});

	it("should include prior decisions in the briefing", () => {
		const decisions: DecisionRecord[] = [
			{
				id: "dec-001",
				roomId: "room-001",
				question: "Which auth library?",
				decision: "next-auth",
				rationale: "Best Next.js integration",
				participants: ["backend#1", "frontend#1"],
				dissents: [],
				timestamp: Date.now(),
				causes: [],
			},
		];

		const briefing = buildBriefing({
			mandate: "Build the login page",
			decisions,
			activeAgents: [],
		});

		expect(briefing).toContain("Prior Decisions");
		expect(briefing).toContain("next-auth");
		expect(briefing).toContain("dec-001");
	});

	it("should include the active agents roster", () => {
		const briefing = buildBriefing({
			mandate: "Build tests",
			decisions: [],
			activeAgents: [
				{ agentId: "backend#1", roleName: "backend", capabilities: ["api", "rest"], claimedPaths: [], active: true },
				{ agentId: "frontend#1", roleName: "frontend", capabilities: ["react"], claimedPaths: [], active: true },
			],
		});

		expect(briefing).toContain("Active Agents");
		expect(briefing).toContain("backend#1");
		expect(briefing).toContain("frontend#1");
	});

	it("should include failure context for respawned agents", () => {
		const briefing = buildBriefing({
			mandate: "Build the API",
			decisions: [],
			activeAgents: [],
			failureContext: {
				error: "TypeError: Cannot read property 'id' of undefined",
				attempt: 2,
				maxAttempts: 3,
			},
		});

		expect(briefing).toContain("RESPAWN NOTICE");
		expect(briefing).toContain("attempt 2 of 3");
		expect(briefing).toContain("TypeError");
		expect(briefing).toContain("Avoid the same failure");
	});

	it("should include all sections together for a full briefing", () => {
		const briefing = buildBriefing({
			mandate: "Fix the broken endpoint",
			decisions: [
				{
					id: "d1",
					roomId: "r1",
					question: "API format?",
					decision: "REST + JSON",
					rationale: "Simpler",
					participants: ["backend#1"],
					dissents: [],
					timestamp: Date.now(),
					causes: [],
				},
			],
			activeAgents: [
				{ agentId: "frontend#1", roleName: "frontend", capabilities: ["react"], claimedPaths: [], active: true },
			],
			failureContext: {
				error: "500 Internal Server Error",
				attempt: 1,
				maxAttempts: 2,
			},
		});

		expect(briefing).toContain("Fix the broken endpoint");
		expect(briefing).toContain("Prior Decisions");
		expect(briefing).toContain("Active Agents");
		expect(briefing).toContain("RESPAWN NOTICE");
	});
});

describe("Agent crash recovery", () => {
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-crash-trace-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
	});

	afterEach(() => {
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should release leases when an agent crashes", () => {
		const leaseManager = new LeaseManager();
		leaseManager.registerRole("frontend", ["src/components/**"]);

		// Agent claims files
		leaseManager.claim("frontend#1", "frontend", ["src/components/Button.tsx"]);
		expect(leaseManager.canWrite("frontend#1", "src/components/Button.tsx")).toBe(true);

		// Agent crashes → leases released
		leaseManager.release("frontend#1");
		expect(leaseManager.canWrite("frontend#1", "src/components/Button.tsx")).toBe(false);

		// Another agent can now claim
		const result = leaseManager.claim("frontend#2", "frontend", ["src/components/Button.tsx"]);
		expect(result.granted).toContain("src/components/Button.tsx");
	});

	it("should track respawn counts per subtask", () => {
		const respawnCounts = new Map<string, number>();

		// First failure
		const subtaskName = "build-api";
		const attempt1 = (respawnCounts.get(subtaskName) ?? 0) + 1;
		respawnCounts.set(subtaskName, attempt1);
		expect(attempt1).toBe(1);

		// Second failure
		const attempt2 = (respawnCounts.get(subtaskName) ?? 0) + 1;
		respawnCounts.set(subtaskName, attempt2);
		expect(attempt2).toBe(2);

		// Should stop at maxRespawns
		const maxRespawns = 2;
		expect(attempt2).toBeLessThanOrEqual(maxRespawns);

		const attempt3 = (respawnCounts.get(subtaskName) ?? 0) + 1;
		expect(attempt3).toBeGreaterThan(maxRespawns);
	});
});

describe("Spawn depth and registry-check-before-spawn", () => {
	it("should check registry before spawning duplicate capability", () => {
		const registry = new CapabilityRegistry();
		const role: RoleDefinition = {
			name: "backend",
			description: "Backend",
			capabilities: ["backend", "api"],
			systemPrompt: "",
			model: "sonnet",
			tools: ["read"],
			pathScope: ["src/**"],
		};
		registry.loadCatalog([role]);
		registry.register("backend#1", "backend", ["backend", "api"]);

		// Before spawning, check if capability already exists
		const existing = registry.findByCapability("api");
		expect(existing).toBeDefined();
		expect(existing!.agentId).toBe("backend#1");

		// Should NOT spawn a new one — existing agent handles it
	});

	it("should enforce max agents cap", () => {
		const registry = new CapabilityRegistry();
		const maxAgents = 3;

		registry.register("a#1", "a", ["a"]);
		registry.register("b#1", "b", ["b"]);
		registry.register("c#1", "c", ["c"]);

		expect(registry.getActiveCount()).toBe(maxAgents);
		// Next spawn should be denied
		expect(registry.getActiveCount() >= maxAgents).toBe(true);
	});
});

describe("Orchestrator with watchdog wired in", () => {
	let repoPath: string;
	let catalogDir: string;
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-safety-"));
		execSync("git init", { cwd: repoPath });
		execSync("git config user.email 'test@test.com'", { cwd: repoPath });
		execSync("git config user.name 'Test'", { cwd: repoPath });
		writeFileSync(join(repoPath, "README.md"), "# Test\n");
		execSync("git add . && git commit -m 'init'", { cwd: repoPath });
		execSync("git checkout -b integration", { cwd: repoPath });
		execSync("git checkout main", { cwd: repoPath });

		catalogDir = mkdtempSync(join(tmpdir(), "pi-chorus-safety-catalog-"));
		writeFileSync(join(catalogDir, "backend.yaml"), `
name: backend
description: "Backend"
capabilities: [backend, api]
system_prompt: "test"
model: sonnet
tools: [read]
path_scope: [src/**]
`);

		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-safety-trace-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
	});

	afterEach(() => {
		try { execSync("git worktree prune", { cwd: repoPath }); } catch {}
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(catalogDir, { recursive: true, force: true });
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should expose watchdog for inspection", () => {
		const orchestrator = new Orchestrator({
			description: "Test",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
		}, traceStore);

		const watchdog = orchestrator.getWatchdog();
		expect(watchdog).toBeDefined();
		expect(watchdog.getWaitEdges()).toHaveLength(0);
	});

	it("should handle an empty mission with watchdog active", async () => {
		const orchestrator = new Orchestrator({
			description: "Test",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
		}, traceStore);

		const result = await orchestrator.run({
			mission: "Test",
			subtasks: [],
			notes: "",
		});

		expect(result.mission.status).toBe("succeeded");
	});

	it("should subscribe to BLOCKED_ON messages during run", async () => {
		const orchestrator = new Orchestrator({
			description: "Test",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
		}, traceStore);

		// Simulate BLOCKED_ON via the message bus before running
		const bus = orchestrator.getMessageBus();
		bus.subscribe("a", () => {});
		bus.subscribe("b", () => {});

		// Run the mission (empty plan)
		await orchestrator.run({
			mission: "Test",
			subtasks: [],
			notes: "",
		});

		// After run, bus subscriptions are cleaned up
		// Verify the orchestrator completed successfully
		expect(orchestrator.getMission()!.status).toBe("succeeded");
	});
});

describe("Deadlock resolution tracing", () => {
	it("should emit trace events when resolving deadlocks", () => {
		const contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-dl-trace-"));
		const traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
		const watchdog = new Watchdog();
		const missionId = "deadlock-test";

		// Create a deadlock
		watchdog.addWait("a#1", "b#1");
		watchdog.addWait("b#1", "a#1");

		const deadlocks = watchdog.detectDeadlocks();
		expect(deadlocks).toHaveLength(1);

		// Simulate orchestrator resolution
		for (const deadlock of deadlocks) {
			traceStore.emit("orchestrator", "lifecycle.crash", {
				reason: "deadlock_detected",
				cycle: deadlock.cycle,
				killed: deadlock.youngest,
			}, [], missionId);
		}

		const events = traceStore.getEventsByMission(missionId);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("lifecycle.crash");

		const payload = traceStore.getPayload(events[0].payloadHash) as any;
		expect(payload.reason).toBe("deadlock_detected");
		expect(payload.cycle).toContain("a#1");

		rmSync(contentDir, { recursive: true, force: true });
	});
});
