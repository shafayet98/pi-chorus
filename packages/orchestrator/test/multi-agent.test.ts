import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorktreeManager, VerificationGate } from "@pi-chorus/worktree";
import { LeaseManager, MessageBus, CapabilityRegistry, RoomManager } from "@pi-chorus/coordination";
import type { RoleDefinition, AgentMessage as CoordMessage } from "@pi-chorus/coordination";
import { TraceStore, LamportClock, ContentStore } from "@pi-chorus/trace";

// In-memory database for testing
class InMemoryDatabase {
	private tables = new Map<string, any[]>();

	exec(sql: string): void {
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

describe("Two agents: messaging", () => {
	it("should deliver DMs between agents via MessageBus", () => {
		const bus = new MessageBus();
		const frontendInbox: CoordMessage[] = [];
		const backendInbox: CoordMessage[] = [];

		bus.subscribe("frontend#1", (msg) => frontendInbox.push(msg));
		bus.subscribe("backend#1", (msg) => backendInbox.push(msg));

		// Frontend asks backend for an interface
		const msg1 = bus.send("frontend#1", "backend#1", "REQUEST_INTERFACE", {
			content: "What shape should the /api/users response take?",
		}, 1);

		expect(backendInbox).toHaveLength(1);
		expect(backendInbox[0].type).toBe("REQUEST_INTERFACE");
		expect(backendInbox[0].from).toBe("frontend#1");
		expect(frontendInbox).toHaveLength(0); // Not delivered to sender

		// Backend responds with a proposal
		const msg2 = bus.send("backend#1", "frontend#1", "PROPOSE", {
			content: "{ id: number, name: string, email: string }",
		}, 2);

		expect(frontendInbox).toHaveLength(1);
		expect(frontendInbox[0].type).toBe("PROPOSE");
		expect(frontendInbox[0].from).toBe("backend#1");

		// Frontend accepts
		bus.send("frontend#1", "backend#1", "ACCEPT", {
			content: "Looks good, I'll use that shape.",
		}, 3);

		expect(backendInbox).toHaveLength(2);
		expect(backendInbox[1].type).toBe("ACCEPT");
	});

	it("should track all messages globally for tracing", () => {
		const bus = new MessageBus();
		const allMessages: CoordMessage[] = [];
		bus.subscribeAll((msg) => allMessages.push(msg));

		bus.subscribe("a", () => {});
		bus.subscribe("b", () => {});

		bus.send("a", "b", "INFO", { content: "hello" }, 1);
		bus.send("b", "a", "INFO", { content: "hi back" }, 2);
		bus.send("a", "b", "DONE", {}, 3);

		expect(allMessages).toHaveLength(3);
		expect(allMessages.map((m) => m.type)).toEqual(["INFO", "INFO", "DONE"]);
	});
});

describe("Two agents: lease contention", () => {
	let leaseManager: LeaseManager;

	beforeEach(() => {
		leaseManager = new LeaseManager();
		leaseManager.registerRole("frontend", ["src/components/**", "src/pages/**"]);
		leaseManager.registerRole("backend", ["src/api/**", "src/services/**"]);
	});

	it("should allow two agents to claim non-overlapping files in the same scope", () => {
		// Both are frontend agents but claiming different files
		leaseManager.registerRole("frontend", ["src/components/**"]);
		const r1 = leaseManager.claim("frontend#1", "frontend", ["src/components/Button.tsx"]);
		const r2 = leaseManager.claim("frontend#2", "frontend", ["src/components/Modal.tsx"]);

		expect(r1.granted).toContain("src/components/Button.tsx");
		expect(r2.granted).toContain("src/components/Modal.tsx");
	});

	it("should prevent cross-role scope violations", () => {
		// Frontend tries to claim backend paths
		const r = leaseManager.claim("frontend#1", "frontend", ["src/api/users.ts"]);
		expect(r.denied).toContain("src/api/users.ts");

		// Backend tries to claim frontend paths
		const r2 = leaseManager.claim("backend#1", "backend", ["src/components/Button.tsx"]);
		expect(r2.denied).toContain("src/components/Button.tsx");
	});

	it("should prevent overlapping claims between agents of different roles", () => {
		// Imagine both roles have overlapping scope - register a shared scope
		leaseManager.registerRole("fullstack", ["src/**"]);
		leaseManager.claim("frontend#1", "frontend", ["src/components/shared.ts"]);
		// Fullstack agent tries to claim the same file
		const r = leaseManager.claim("fullstack#1", "fullstack", ["src/components/shared.ts"]);
		expect(r.denied).toContain("src/components/shared.ts");
	});

	it("should report the holder when a claim is denied", () => {
		leaseManager.claim("frontend#1", "frontend", ["src/components/Button.tsx"]);
		const holder = leaseManager.getHolder("src/components/Button.tsx");
		expect(holder).toBe("frontend#1");
	});

	it("should allow reclaiming after release", () => {
		leaseManager.claim("frontend#1", "frontend", ["src/components/Button.tsx"]);
		leaseManager.release("frontend#1");

		const r = leaseManager.claim("frontend#2", "frontend", ["src/components/Button.tsx"]);
		expect(r.granted).toContain("src/components/Button.tsx");
	});
});

describe("Two agents: parallel worktrees with merge", () => {
	let repoPath: string;

	beforeEach(() => {
		repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-parallel-"));
		execSync("git init", { cwd: repoPath });
		execSync("git config user.email 'test@test.com'", { cwd: repoPath });
		execSync("git config user.name 'Test'", { cwd: repoPath });
		writeFileSync(join(repoPath, "README.md"), "# Test Project\n");
		execSync("git add . && git commit -m 'init'", { cwd: repoPath });
		execSync("git checkout -b integration", { cwd: repoPath });
		execSync("git checkout main", { cwd: repoPath });
	});

	afterEach(() => {
		try {
			execSync("git worktree prune", { cwd: repoPath });
		} catch {}
		rmSync(repoPath, { recursive: true, force: true });
	});

	it("should merge two agents' non-conflicting work into integration branch", () => {
		const manager = new WorktreeManager({
			repoPath,
			integrationBranch: "integration",
			scratchPath: join(repoPath, ".scratch"),
		});

		// Create two worktrees
		const wt1 = manager.create("frontend#1");
		const wt2 = manager.create("backend#1");

		// Frontend creates components
		mkdirSync(join(wt1.path, "src", "components"), { recursive: true });
		writeFileSync(join(wt1.path, "src", "components", "Button.tsx"), "export const Button = () => <button/>;\n");
		execSync("git add . && git commit -m 'Add Button component'", { cwd: wt1.path });

		// Backend creates API
		mkdirSync(join(wt2.path, "src", "api"), { recursive: true });
		writeFileSync(join(wt2.path, "src", "api", "users.ts"), "export const getUsers = () => [];\n");
		execSync("git add . && git commit -m 'Add users endpoint'", { cwd: wt2.path });

		// Merge both
		const r1 = manager.merge("frontend#1");
		expect(r1.success).toBe(true);

		const r2 = manager.merge("backend#1");
		expect(r2.success).toBe(true);

		// Verify both files exist on integration branch
		execSync("git checkout integration", { cwd: repoPath });
		expect(existsSync(join(repoPath, "src", "components", "Button.tsx"))).toBe(true);
		expect(existsSync(join(repoPath, "src", "api", "users.ts"))).toBe(true);

		// Run verification gate
		const gate = new VerificationGate([
			"test -f src/components/Button.tsx",
			"test -f src/api/users.ts",
		]);
		const gateResult = gate.run(repoPath);
		expect(gateResult.passed).toBe(true);

		manager.remove("frontend#1");
		manager.remove("backend#1");
	});

	it("should detect conflicts when two agents modify the same file", () => {
		const manager = new WorktreeManager({
			repoPath,
			integrationBranch: "integration",
			scratchPath: join(repoPath, ".scratch"),
		});

		const wt1 = manager.create("agent-a");
		const wt2 = manager.create("agent-b");

		// Both modify README.md
		writeFileSync(join(wt1.path, "README.md"), "# Agent A was here\n");
		execSync("git add . && git commit -m 'Agent A'", { cwd: wt1.path });

		writeFileSync(join(wt2.path, "README.md"), "# Agent B was here\n");
		execSync("git add . && git commit -m 'Agent B'", { cwd: wt2.path });

		// First merge succeeds
		const r1 = manager.merge("agent-a");
		expect(r1.success).toBe(true);

		// Second merge conflicts
		const r2 = manager.merge("agent-b");
		expect(r2.success).toBe(false);
		expect(r2.conflicts).toContain("README.md");

		manager.remove("agent-a");
		manager.remove("agent-b");
	});
});

describe("Two agents: scratch space communication", () => {
	let scratchPath: string;

	beforeEach(() => {
		scratchPath = mkdtempSync(join(tmpdir(), "pi-chorus-scratch-"));
	});

	afterEach(() => {
		rmSync(scratchPath, { recursive: true, force: true });
	});

	it("should allow agents to share data via scratch space", () => {
		// Backend writes an interface definition to scratch
		const interfacePath = join(scratchPath, "interfaces", "user.ts");
		mkdirSync(join(scratchPath, "interfaces"), { recursive: true });
		writeFileSync(interfacePath, "export interface User { id: number; name: string; email: string; }\n");

		// Frontend reads it
		expect(existsSync(interfacePath)).toBe(true);
		const content = readFileSync(interfacePath, "utf-8");
		expect(content).toContain("interface User");
	});
});

describe("Two agents: capability registry", () => {
	it("should find existing agents before requesting spawn", () => {
		const registry = new CapabilityRegistry();
		registry.loadCatalog([frontendRole, backendRole]);
		registry.register("frontend#1", "frontend", ["frontend", "react"]);

		// Another agent asks: "is there someone who does react?"
		const existing = registry.findByCapability("react");
		expect(existing).toBeDefined();
		expect(existing!.agentId).toBe("frontend#1");
	});

	it("should find matching role in catalog when no agent is active", () => {
		const registry = new CapabilityRegistry();
		registry.loadCatalog([frontendRole, backendRole]);

		// No agents registered yet — look up in catalog
		const existing = registry.findByCapability("api");
		expect(existing).toBeUndefined();

		const role = registry.findRoleByCapability("api");
		expect(role).toBeDefined();
		expect(role!.name).toBe("backend");
	});

	it("should track active vs deactivated agents", () => {
		const registry = new CapabilityRegistry();
		registry.register("frontend#1", "frontend", ["frontend"]);
		expect(registry.getActiveCount()).toBe(1);

		registry.deactivate("frontend#1");
		expect(registry.getActiveCount()).toBe(0);

		// Deactivated agent should not be found
		const found = registry.findByCapability("frontend");
		expect(found).toBeUndefined();
	});
});

describe("Room Manager", () => {
	let roomManager: RoomManager;
	let messageBus: MessageBus;

	beforeEach(() => {
		messageBus = new MessageBus();
		roomManager = new RoomManager(messageBus);
	});

	it("should open and resolve a room", () => {
		const room = roomManager.open(
			"frontend#1",
			"API Contract",
			"What shape should /api/users return?",
			["backend#1"],
			10,
		);

		expect(room.status).toBe("open");
		expect(room.members).toContain("frontend#1");
		expect(room.members).toContain("backend#1");
		expect(room.turnBudget).toBe(10);

		// Record some turns
		expect(roomManager.recordTurn(room.id)).toBe(true);
		expect(roomManager.recordTurn(room.id)).toBe(true);

		// Resolve with a decision
		const decision = roomManager.resolve(
			room.id,
			"{ id: number, name: string, email: string }",
			"Backend proposed this shape, frontend agreed it covers all needed fields.",
			[],
		);

		expect(decision.question).toBe("What shape should /api/users return?");
		expect(decision.decision).toContain("id: number");
		expect(decision.participants).toContain("frontend#1");

		// Room is now resolved
		const resolved = roomManager.getRoom(room.id);
		expect(resolved!.status).toBe("resolved");
		expect(resolved!.turnsUsed).toBe(2);
	});

	it("should expire rooms that hit turn budget", () => {
		const room = roomManager.open("a", "Topic", "Question?", ["b"], 3);

		roomManager.recordTurn(room.id); // 1
		roomManager.recordTurn(room.id); // 2
		const withinBudget = roomManager.recordTurn(room.id); // 3 = budget hit

		expect(withinBudget).toBe(false);
		expect(roomManager.getRoom(room.id)!.status).toBe("expired");
		expect(roomManager.getExpiredRooms()).toHaveLength(1);
	});

	it("should allow inviting additional agents", () => {
		const room = roomManager.open("a", "Topic", "Question?", ["b"], 10);
		roomManager.invite(room.id, "c");

		expect(roomManager.getRoom(room.id)!.members).toContain("c");
	});

	it("should make decision records retrievable by ID", () => {
		const room = roomManager.open("a", "Topic", "Q?", ["b"], 10);
		const decision = roomManager.resolve(room.id, "Answer", "Because", []);

		const retrieved = roomManager.getDecision(decision.id);
		expect(retrieved).toBeDefined();
		expect(retrieved!.decision).toBe("Answer");
	});
});

describe("Full pipeline: two agents → merge → gate → trace", () => {
	let repoPath: string;
	let db: InMemoryDatabase;
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-pipeline-"));
		execSync("git init", { cwd: repoPath });
		execSync("git config user.email 'test@test.com'", { cwd: repoPath });
		execSync("git config user.name 'Test'", { cwd: repoPath });
		writeFileSync(join(repoPath, "README.md"), "# Project\n");
		execSync("git add . && git commit -m 'init'", { cwd: repoPath });
		execSync("git checkout -b integration", { cwd: repoPath });
		execSync("git checkout main", { cwd: repoPath });

		db = new InMemoryDatabase();
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-pipeline-trace-"));
		traceStore = new TraceStore(db, contentDir);
	});

	afterEach(() => {
		try { execSync("git worktree prune", { cwd: repoPath }); } catch {}
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should run the complete two-agent pipeline", () => {
		const missionId = "mission-pipeline-001";
		const scratchPath = join(repoPath, ".scratch");
		mkdirSync(scratchPath, { recursive: true });

		// Set up shared infrastructure
		const messageBus = new MessageBus();
		const leaseManager = new LeaseManager();
		leaseManager.registerRole("frontend", ["src/components/**"]);
		leaseManager.registerRole("backend", ["src/api/**"]);

		const capabilityRegistry = new CapabilityRegistry();
		capabilityRegistry.loadCatalog([frontendRole, backendRole]);
		capabilityRegistry.register("frontend#1", "frontend", ["frontend", "react"]);
		capabilityRegistry.register("backend#1", "backend", ["backend", "api"]);

		const worktreeManager = new WorktreeManager({
			repoPath,
			integrationBranch: "integration",
			scratchPath,
		});

		// 1. Spawn events
		traceStore.emit("orchestrator", "agent.spawn", { agentId: "backend#1", role: "backend" }, [], missionId);
		traceStore.emit("orchestrator", "agent.spawn", { agentId: "frontend#1", role: "frontend" }, [], missionId);

		// 2. Create worktrees
		const wt1 = worktreeManager.create("backend#1");
		const wt2 = worktreeManager.create("frontend#1");

		// 3. Backend agent works
		traceStore.emit("backend#1", "lifecycle.start", { role: "backend" }, [], missionId);

		// Backend claims files
		const backendClaim = leaseManager.claim("backend#1", "backend", ["src/api/users.ts"]);
		expect(backendClaim.granted).toContain("src/api/users.ts");
		traceStore.emit("backend#1", "lease.grant", { paths: backendClaim.granted }, [], missionId);

		// Backend writes code
		mkdirSync(join(wt1.path, "src", "api"), { recursive: true });
		writeFileSync(
			join(wt1.path, "src", "api", "users.ts"),
			'export interface User { id: number; name: string; }\nexport const getUsers = (): User[] => [];\n',
		);
		traceStore.emit("backend#1", "file.write", { path: "src/api/users.ts" }, [], missionId);

		// Backend writes interface to scratch space
		mkdirSync(join(scratchPath, "interfaces"), { recursive: true });
		writeFileSync(
			join(scratchPath, "interfaces", "user.ts"),
			"export interface User { id: number; name: string; }\n",
		);

		// Backend sends message to frontend
		const msg = messageBus.send("backend#1", "frontend#1", "INFO", {
			content: "User interface is ready in scratch/interfaces/user.ts",
		}, 1);
		traceStore.emit("backend#1", "message.send", { to: "frontend#1", messageId: msg.id }, [], missionId);

		// Backend commits and signals done
		execSync("git add . && git commit -m 'Add users API'", { cwd: wt1.path });
		leaseManager.release("backend#1");
		traceStore.emit("backend#1", "lifecycle.stop", { status: "done" }, [], missionId);

		// 4. Frontend agent works (reads scratch, creates component)
		traceStore.emit("frontend#1", "lifecycle.start", { role: "frontend" }, [], missionId);

		// Frontend reads the interface from scratch
		const userInterface = readFileSync(join(scratchPath, "interfaces", "user.ts"), "utf-8");
		expect(userInterface).toContain("interface User");

		// Frontend claims files
		const frontendClaim = leaseManager.claim("frontend#1", "frontend", ["src/components/UserList.tsx"]);
		expect(frontendClaim.granted).toContain("src/components/UserList.tsx");
		traceStore.emit("frontend#1", "lease.grant", { paths: frontendClaim.granted }, [], missionId);

		// Frontend verifies it can't claim backend paths
		const badClaim = leaseManager.claim("frontend#1", "frontend", ["src/api/other.ts"]);
		expect(badClaim.denied).toContain("src/api/other.ts");

		// Frontend writes component
		mkdirSync(join(wt2.path, "src", "components"), { recursive: true });
		writeFileSync(
			join(wt2.path, "src", "components", "UserList.tsx"),
			'import type { User } from "../api/users";\nexport const UserList = (props: { users: User[] }) => null;\n',
		);
		traceStore.emit("frontend#1", "file.write", { path: "src/components/UserList.tsx" }, [], missionId);

		execSync("git add . && git commit -m 'Add UserList component'", { cwd: wt2.path });
		leaseManager.release("frontend#1");
		traceStore.emit("frontend#1", "lifecycle.stop", { status: "done" }, [], missionId);

		// 5. Merge both into integration
		const merge1 = worktreeManager.merge("backend#1");
		expect(merge1.success).toBe(true);
		traceStore.emit("orchestrator", "git.merge", { agentId: "backend#1", success: true }, [], missionId);

		const merge2 = worktreeManager.merge("frontend#1");
		expect(merge2.success).toBe(true);
		traceStore.emit("orchestrator", "git.merge", { agentId: "frontend#1", success: true }, [], missionId);

		// 6. Run verification gate
		execSync("git checkout integration", { cwd: repoPath });
		const gate = new VerificationGate([
			"test -f src/api/users.ts",
			"test -f src/components/UserList.tsx",
		]);
		const gateResult = gate.run(repoPath);
		expect(gateResult.passed).toBe(true);
		traceStore.emit("orchestrator", "gate.pass", {}, [], missionId);

		// 7. Verify trace has the full story
		const events = traceStore.getEventsByMission(missionId);
		const kinds = events.map((e) => e.kind);

		// Spawns
		expect(kinds.filter((k) => k === "agent.spawn")).toHaveLength(2);
		// Lifecycle
		expect(kinds.filter((k) => k === "lifecycle.start")).toHaveLength(2);
		expect(kinds.filter((k) => k === "lifecycle.stop")).toHaveLength(2);
		// Leases
		expect(kinds.filter((k) => k === "lease.grant")).toHaveLength(2);
		// File writes
		expect(kinds.filter((k) => k === "file.write")).toHaveLength(2);
		// Merges
		expect(kinds.filter((k) => k === "git.merge")).toHaveLength(2);
		// Gate
		expect(kinds).toContain("gate.pass");
		// Message
		expect(kinds).toContain("message.send");

		// 8. Verify multi-agent event ordering by Lamport clock
		const backendEvents = traceStore.getEventsByAgent("backend#1");
		const frontendEvents = traceStore.getEventsByAgent("frontend#1");
		expect(backendEvents.length).toBeGreaterThan(0);
		expect(frontendEvents.length).toBeGreaterThan(0);

		// Each agent's events should be in Lamport order
		for (let i = 1; i < backendEvents.length; i++) {
			expect(backendEvents[i].clock).toBeGreaterThan(backendEvents[i - 1].clock);
		}
		for (let i = 1; i < frontendEvents.length; i++) {
			expect(frontendEvents[i].clock).toBeGreaterThan(frontendEvents[i - 1].clock);
		}

		// Cleanup
		worktreeManager.remove("backend#1");
		worktreeManager.remove("frontend#1");
	});
});
