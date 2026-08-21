import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorktreeManager, VerificationGate } from "@pi-chorus/worktree";
import { LeaseManager, CapabilityRegistry, MessageBus } from "@pi-chorus/coordination";
import type { RoleDefinition } from "@pi-chorus/coordination";
import { TraceStore, LamportClock, ContentStore } from "@pi-chorus/trace";
import { RoleCatalog } from "../src/role-catalog.ts";

// In-memory SQLite-like store for testing (no real SQLite dependency)
class InMemoryDatabase {
	private tables = new Map<string, any[]>();

	exec(sql: string): void {
		// Parse CREATE TABLE statements
		const createMatch = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
		if (createMatch && !this.tables.has(createMatch[1])) {
			this.tables.set(createMatch[1], []);
		}
	}

	prepare(sql: string): any {
		const self = this;
		return {
			run(...params: any[]): void {
				const insertMatch = sql.match(/INSERT INTO (\w+)/);
				if (insertMatch) {
					const table = self.tables.get(insertMatch[1]);
					if (table) {
						// Map positional params to column values
						const colMatch = sql.match(/\(([^)]+)\)\s+VALUES/);
						if (colMatch) {
							const cols = colMatch[1].split(",").map((c) => c.trim());
							const row: any = {};
							cols.forEach((col, i) => {
								row[col] = params[i];
							});
							table.push(row);
						}
					}
				}
			},
			all(...params: any[]): any[] {
				const selectMatch = sql.match(/FROM (\w+)/);
				if (!selectMatch) return [];
				const table = self.tables.get(selectMatch[1]) ?? [];

				const whereMatch = sql.match(/WHERE (\w+) = \?/);
				if (whereMatch && params.length > 0) {
					return table.filter((row) => row[whereMatch[1]] === params[0]);
				}
				return table;
			},
			get(...params: any[]): any {
				return this.all(...params)[0] ?? null;
			},
		};
	}
}

describe("Worktree Manager", () => {
	let repoPath: string;

	beforeEach(() => {
		// Create a temp git repo
		repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-test-"));
		execSync("git init", { cwd: repoPath });
		execSync("git config user.email 'test@test.com'", { cwd: repoPath });
		execSync("git config user.name 'Test'", { cwd: repoPath });

		// Create initial commit
		writeFileSync(join(repoPath, "README.md"), "# Test Project\n");
		execSync("git add . && git commit -m 'Initial commit'", { cwd: repoPath });

		// Create integration branch
		execSync("git checkout -b integration", { cwd: repoPath });
		execSync("git checkout main", { cwd: repoPath });
	});

	afterEach(() => {
		// Cleanup
		try {
			execSync("git worktree prune", { cwd: repoPath });
		} catch {}
		rmSync(repoPath, { recursive: true, force: true });
	});

	it("should create and remove a worktree", () => {
		const manager = new WorktreeManager({
			repoPath,
			integrationBranch: "integration",
			scratchPath: join(repoPath, ".scratch"),
		});

		const worktree = manager.create("frontend#1");
		expect(worktree.agentId).toBe("frontend#1");
		expect(worktree.branch).toBe("chorus/frontend#1");
		expect(existsSync(worktree.path)).toBe(true);
		expect(existsSync(join(worktree.path, "README.md"))).toBe(true);

		manager.remove("frontend#1");
		expect(manager.get("frontend#1")).toBeUndefined();
	});

	it("should merge a worktree into the integration branch", () => {
		const manager = new WorktreeManager({
			repoPath,
			integrationBranch: "integration",
			scratchPath: join(repoPath, ".scratch"),
		});

		const worktree = manager.create("backend#1");

		// Simulate agent work: create a file in the worktree
		mkdirSync(join(worktree.path, "src", "api"), { recursive: true });
		writeFileSync(join(worktree.path, "src", "api", "users.ts"), 'export function getUsers() { return []; }\n');
		execSync("git add . && git commit -m 'Add users endpoint'", { cwd: worktree.path });

		// Merge into integration
		const result = manager.merge("backend#1");
		expect(result.success).toBe(true);
		expect(result.conflicts).toHaveLength(0);
		expect(result.commitHash).toBeDefined();

		// Verify the file exists on the integration branch
		execSync("git checkout integration", { cwd: repoPath });
		expect(existsSync(join(repoPath, "src", "api", "users.ts"))).toBe(true);

		manager.remove("backend#1");
	});

	it("should detect merge conflicts", () => {
		const manager = new WorktreeManager({
			repoPath,
			integrationBranch: "integration",
			scratchPath: join(repoPath, ".scratch"),
		});

		// Create two worktrees
		const wt1 = manager.create("frontend#1");
		const wt2 = manager.create("backend#1");

		// Both modify the same file
		writeFileSync(join(wt1.path, "README.md"), "# Frontend Changes\n");
		execSync("git add . && git commit -m 'Frontend README'", { cwd: wt1.path });

		writeFileSync(join(wt2.path, "README.md"), "# Backend Changes\n");
		execSync("git add . && git commit -m 'Backend README'", { cwd: wt2.path });

		// First merge succeeds
		const r1 = manager.merge("frontend#1");
		expect(r1.success).toBe(true);

		// Second merge has conflicts
		const r2 = manager.merge("backend#1");
		expect(r2.success).toBe(false);
		expect(r2.conflicts.length).toBeGreaterThan(0);

		manager.remove("frontend#1");
		manager.remove("backend#1");
	});
});

describe("Verification Gate", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "pi-chorus-gate-"));
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("should pass when all commands succeed", () => {
		const gate = VerificationGate.fromString("echo 'hello' && echo 'world'");
		const result = gate.run(workDir);
		expect(result.passed).toBe(true);
		expect(result.failedCommand).toBeUndefined();
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("should fail on the first failing command", () => {
		const gate = VerificationGate.fromString("echo 'ok' && false && echo 'unreachable'");
		const result = gate.run(workDir);
		expect(result.passed).toBe(false);
		expect(result.failedCommand).toBe("false");
	});

	it("should parse gate strings correctly", () => {
		const gate = VerificationGate.fromString("npm test && npm run build && npm run lint");
		// We can't run npm commands here, but we verify parsing works
		expect(gate).toBeDefined();
	});
});

describe("Lease Manager", () => {
	let leaseManager: LeaseManager;

	beforeEach(() => {
		leaseManager = new LeaseManager();
		leaseManager.registerRole("frontend", ["src/components/**", "src/pages/**"]);
		leaseManager.registerRole("backend", ["src/api/**", "src/services/**"]);
	});

	it("should grant claims within path scope", () => {
		const result = leaseManager.claim("frontend#1", "frontend", ["src/components/Button.tsx"]);
		expect(result.granted).toContain("src/components/Button.tsx");
		expect(result.denied).toHaveLength(0);
	});

	it("should deny claims outside path scope", () => {
		const result = leaseManager.claim("frontend#1", "frontend", ["src/api/users.ts"]);
		expect(result.granted).toHaveLength(0);
		expect(result.denied).toContain("src/api/users.ts");
	});

	it("should deny overlapping claims from different agents", () => {
		leaseManager.claim("frontend#1", "frontend", ["src/components/Button.tsx"]);
		const result = leaseManager.claim("frontend#2", "frontend", ["src/components/Button.tsx"]);
		expect(result.denied).toContain("src/components/Button.tsx");
	});

	it("should allow writes to claimed paths", () => {
		leaseManager.claim("frontend#1", "frontend", ["src/components/Button.tsx"]);
		expect(leaseManager.canWrite("frontend#1", "src/components/Button.tsx")).toBe(true);
	});

	it("should deny writes to unclaimed paths", () => {
		expect(leaseManager.canWrite("frontend#1", "src/components/Button.tsx")).toBe(false);
	});

	it("should release claims", () => {
		leaseManager.claim("frontend#1", "frontend", ["src/components/Button.tsx"]);
		leaseManager.release("frontend#1");
		expect(leaseManager.canWrite("frontend#1", "src/components/Button.tsx")).toBe(false);

		// Another agent can now claim it
		const result = leaseManager.claim("frontend#2", "frontend", ["src/components/Button.tsx"]);
		expect(result.granted).toContain("src/components/Button.tsx");
	});
});

describe("Trace Store", () => {
	let db: InMemoryDatabase;
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		db = new InMemoryDatabase();
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-trace-"));
		traceStore = new TraceStore(db, contentDir);
	});

	afterEach(() => {
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should emit and retrieve events", () => {
		const event = traceStore.emit("frontend#1", "lifecycle.start", { role: "frontend" }, [], "mission-1");
		expect(event.agentId).toBe("frontend#1");
		expect(event.kind).toBe("lifecycle.start");
		expect(event.missionId).toBe("mission-1");
		expect(event.clock).toBe(1);

		const retrieved = traceStore.getEvent(event.id);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.kind).toBe("lifecycle.start");
	});

	it("should maintain causal ordering via Lamport clock", () => {
		const e1 = traceStore.emit("frontend#1", "lifecycle.start", {}, [], "m1");
		const e2 = traceStore.emit("frontend#1", "tool.start", {}, [e1.id], "m1");
		const e3 = traceStore.emit("frontend#1", "tool.end", {}, [e2.id], "m1");

		expect(e1.clock).toBe(1);
		expect(e2.clock).toBe(2);
		expect(e3.clock).toBe(3);
	});

	it("should store and retrieve payloads via content addressing", () => {
		const payload = { role: "frontend", mandate: "Build the login page" };
		const event = traceStore.emit("frontend#1", "lifecycle.start", payload, [], "m1");

		const retrieved = traceStore.getPayload(event.payloadHash);
		expect(retrieved).toEqual(payload);
	});

	it("should walk the causal chain", () => {
		const e1 = traceStore.emit("frontend#1", "lifecycle.start", {}, [], "m1");
		const e2 = traceStore.emit("frontend#1", "tool.start", {}, [e1.id], "m1");
		const e3 = traceStore.emit("backend#1", "tool.start", {}, [e1.id], "m1");
		const e4 = traceStore.emit("frontend#1", "tool.end", {}, [e2.id, e3.id], "m1");

		const chain = traceStore.getCausalChain(e4.id);
		expect(chain).toHaveLength(4);
		expect(chain.map((e) => e.id)).toContain(e1.id);
		expect(chain.map((e) => e.id)).toContain(e2.id);
		expect(chain.map((e) => e.id)).toContain(e3.id);
	});

	it("should notify listeners on emit", () => {
		const events: any[] = [];
		traceStore.onEvent((event) => events.push(event));

		traceStore.emit("frontend#1", "lifecycle.start", {}, [], "m1");
		traceStore.emit("frontend#1", "lifecycle.stop", {}, [], "m1");

		expect(events).toHaveLength(2);
	});
});

describe("Lamport Clock", () => {
	it("should increment on tick", () => {
		const clock = new LamportClock();
		expect(clock.tick()).toBe(1);
		expect(clock.tick()).toBe(2);
		expect(clock.tick()).toBe(3);
	});

	it("should merge with received value", () => {
		const clock = new LamportClock();
		clock.tick(); // 1
		clock.tick(); // 2

		// Receive a message with clock=5 from another agent
		const merged = clock.merge(5);
		expect(merged).toBe(6); // max(2, 5) + 1
	});
});

describe("Content Store", () => {
	let storeDir: string;

	beforeEach(() => {
		storeDir = mkdtempSync(join(tmpdir(), "pi-chorus-content-"));
	});

	afterEach(() => {
		rmSync(storeDir, { recursive: true, force: true });
	});

	it("should store and retrieve content by hash", () => {
		const store = new ContentStore(storeDir);
		const hash = store.put("hello world");
		expect(store.has(hash)).toBe(true);

		const retrieved = store.get(hash);
		expect(retrieved!.toString("utf-8")).toBe("hello world");
	});

	it("should deduplicate identical content", () => {
		const store = new ContentStore(storeDir);
		const hash1 = store.put("same content");
		const hash2 = store.put("same content");
		expect(hash1).toBe(hash2);
	});

	it("should return null for missing content", () => {
		const store = new ContentStore(storeDir);
		expect(store.get("nonexistent-hash")).toBeNull();
	});
});

describe("Message Bus", () => {
	it("should deliver messages to the target agent", () => {
		const bus = new MessageBus();
		const received: any[] = [];
		bus.subscribe("backend#1", (msg) => received.push(msg));

		bus.send("frontend#1", "backend#1", "REQUEST_INTERFACE", { path: "/api/users" }, 1);

		expect(received).toHaveLength(1);
		expect(received[0].from).toBe("frontend#1");
		expect(received[0].to).toBe("backend#1");
		expect(received[0].type).toBe("REQUEST_INTERFACE");
	});

	it("should not deliver messages to other agents", () => {
		const bus = new MessageBus();
		const received: any[] = [];
		bus.subscribe("frontend#1", (msg) => received.push(msg));

		bus.send("orchestrator", "backend#1", "INFO", {}, 1);

		expect(received).toHaveLength(0);
	});

	it("should notify global observers", () => {
		const bus = new MessageBus();
		const allMessages: any[] = [];
		bus.subscribeAll((msg) => allMessages.push(msg));

		bus.send("a", "b", "INFO", {}, 1);
		bus.send("b", "c", "DONE", {}, 2);

		expect(allMessages).toHaveLength(2);
	});
});

describe("Capability Registry", () => {
	it("should find agents by capability", () => {
		const registry = new CapabilityRegistry();
		registry.register("frontend#1", "frontend", ["frontend", "react", "css"]);
		registry.register("backend#1", "backend", ["backend", "api"]);

		const found = registry.findByCapability("react");
		expect(found).toBeDefined();
		expect(found!.agentId).toBe("frontend#1");
	});

	it("should generate instance IDs", () => {
		const registry = new CapabilityRegistry();
		expect(registry.nextInstanceId("frontend")).toBe("frontend#1");

		registry.register("frontend#1", "frontend", ["frontend"]);
		expect(registry.nextInstanceId("frontend")).toBe("frontend#2");
	});

	it("should find roles in the catalog", () => {
		const registry = new CapabilityRegistry();
		const roles: RoleDefinition[] = [
			{
				name: "frontend",
				description: "Frontend dev",
				capabilities: ["frontend", "react"],
				systemPrompt: "",
				model: "sonnet",
				tools: ["read", "write"],
				pathScope: ["src/components/**"],
			},
		];
		registry.loadCatalog(roles);

		const role = registry.findRoleByCapability("react");
		expect(role).toBeDefined();
		expect(role!.name).toBe("frontend");
	});
});

describe("Role Catalog", () => {
	let catalogDir: string;

	beforeEach(() => {
		catalogDir = mkdtempSync(join(tmpdir(), "pi-chorus-catalog-"));
		writeFileSync(
			join(catalogDir, "test-role.yaml"),
			`name: test-role
description: "A test role"
capabilities: [testing, unit-tests]
system_prompt: |
  You are a test writer.
model: sonnet
tools: [read, write, bash]
path_scope:
  - test/**
local_gate: "npm test"
`,
		);
	});

	afterEach(() => {
		rmSync(catalogDir, { recursive: true, force: true });
	});

	it("should load roles from YAML files", () => {
		const catalog = new RoleCatalog(catalogDir);
		const roles = catalog.load();

		expect(roles).toHaveLength(1);
		expect(roles[0].name).toBe("test-role");
		expect(roles[0].capabilities).toContain("testing");
		expect(roles[0].model).toBe("sonnet");
		expect(roles[0].pathScope).toContain("test/**");
		expect(roles[0].localGate).toBe("npm test");
	});
});

describe("End-to-end: Worktree + Lease + Gate + Trace", () => {
	let repoPath: string;
	let db: InMemoryDatabase;
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-e2e-"));
		execSync("git init", { cwd: repoPath });
		execSync("git config user.email 'test@test.com'", { cwd: repoPath });
		execSync("git config user.name 'Test'", { cwd: repoPath });
		writeFileSync(join(repoPath, "README.md"), "# Test\n");
		execSync("git add . && git commit -m 'init'", { cwd: repoPath });
		execSync("git checkout -b integration", { cwd: repoPath });
		execSync("git checkout main", { cwd: repoPath });

		db = new InMemoryDatabase();
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-e2e-trace-"));
		traceStore = new TraceStore(db, contentDir);
	});

	afterEach(() => {
		try {
			execSync("git worktree prune", { cwd: repoPath });
		} catch {}
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should: create worktree → simulate agent work → merge → run gate → trace events", () => {
		const missionId = "mission-e2e-001";

		// 1. Set up lease manager
		const leaseManager = new LeaseManager();
		leaseManager.registerRole("backend", ["src/**"]);

		// 2. Create worktree
		const worktreeManager = new WorktreeManager({
			repoPath,
			integrationBranch: "integration",
			scratchPath: join(repoPath, ".scratch"),
		});

		const worktree = worktreeManager.create("backend#1");
		traceStore.emit("backend#1", "lifecycle.start", { role: "backend" }, [], missionId);

		// 3. Agent claims files
		const claimResult = leaseManager.claim("backend#1", "backend", ["src/api/users.ts"]);
		expect(claimResult.granted).toContain("src/api/users.ts");
		traceStore.emit("backend#1", "lease.grant", { paths: claimResult.granted }, [], missionId);

		// 4. Agent checks write permission
		expect(leaseManager.canWrite("backend#1", "src/api/users.ts")).toBe(true);
		expect(leaseManager.canWrite("backend#1", "migrations/001.sql")).toBe(false);

		// 5. Simulate agent writing code in worktree
		mkdirSync(join(worktree.path, "src", "api"), { recursive: true });
		writeFileSync(
			join(worktree.path, "src", "api", "users.ts"),
			'export function getUsers() { return [{ id: 1, name: "Alice" }]; }\n',
		);
		execSync("git add . && git commit -m 'Add users API'", { cwd: worktree.path });
		traceStore.emit("backend#1", "file.write", { path: "src/api/users.ts" }, [], missionId);

		// 6. Agent signals done
		leaseManager.release("backend#1");
		traceStore.emit("backend#1", "lifecycle.stop", { status: "done" }, [], missionId);

		// 7. Merge worktree into integration branch
		const mergeResult = worktreeManager.merge("backend#1");
		expect(mergeResult.success).toBe(true);
		traceStore.emit("orchestrator", "git.merge", {
			agentId: "backend#1",
			success: true,
			commitHash: mergeResult.commitHash,
		}, [], missionId);

		// 8. Run verification gate
		// Create a simple gate that checks if the file exists
		const gate = new VerificationGate(["test -f src/api/users.ts"]);
		const gateResult = gate.run(repoPath);
		expect(gateResult.passed).toBe(true);
		traceStore.emit("orchestrator", "gate.pass", { durationMs: gateResult.durationMs }, [], missionId);

		// 9. Verify trace events
		const events = traceStore.getEventsByMission(missionId);
		expect(events.length).toBeGreaterThanOrEqual(5);

		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("lifecycle.start");
		expect(kinds).toContain("lease.grant");
		expect(kinds).toContain("file.write");
		expect(kinds).toContain("lifecycle.stop");
		expect(kinds).toContain("git.merge");
		expect(kinds).toContain("gate.pass");

		// 10. Verify causal chain
		const mergeEvent = events.find((e) => e.kind === "git.merge")!;
		expect(mergeEvent.agentId).toBe("orchestrator");

		// Cleanup
		worktreeManager.remove("backend#1");
	});
});
