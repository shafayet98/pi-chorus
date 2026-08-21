import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MessageBus, RoomManager, LeaseManager, CapabilityRegistry } from "@pi-chorus/coordination";
import type { RoleDefinition, DecisionRecord } from "@pi-chorus/coordination";
import { TraceStore, createInMemoryDatabase } from "@pi-chorus/trace";
import { Orchestrator } from "../src/orchestrator.ts";
import type { DecompositionPlan } from "../src/task-decomposer.ts";

describe("Room lifecycle via tools simulation", () => {
	let messageBus: MessageBus;
	let roomManager: RoomManager;
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		messageBus = new MessageBus();
		roomManager = new RoomManager(messageBus);
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-rooms-trace-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
	});

	afterEach(() => {
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should open a room, negotiate, and resolve with a decision record", () => {
		const missionId = "room-test-001";

		// Frontend opens a room
		const room = roomManager.open(
			"frontend#1",
			"API Contract: /users",
			"What shape should the /api/users response take?",
			["backend#1"],
			10,
		);

		traceStore.emit("frontend#1", "room.open", {
			roomId: room.id,
			topic: "API Contract: /users",
		}, [], missionId);

		expect(room.status).toBe("open");
		expect(room.members).toEqual(["frontend#1", "backend#1"]);

		// Backend proposes
		roomManager.recordTurn(room.id);
		messageBus.send("backend#1", "frontend#1", "PROPOSE", {
			content: "{ id: number, name: string, email: string }",
			roomId: room.id,
		}, 1, room.id);

		// Frontend counter-proposes
		roomManager.recordTurn(room.id);
		messageBus.send("frontend#1", "backend#1", "PROPOSE", {
			content: "{ id: number, name: string, email: string, avatarUrl?: string }",
			roomId: room.id,
		}, 2, room.id);

		// Backend accepts
		roomManager.recordTurn(room.id);
		messageBus.send("backend#1", "frontend#1", "ACCEPT", {
			content: "Agreed. Will add avatarUrl as optional.",
			roomId: room.id,
		}, 3, room.id);

		// Frontend resolves the room
		const decision = roomManager.resolve(
			room.id,
			"{ id: number, name: string, email: string, avatarUrl?: string }",
			"Backend agreed to add optional avatarUrl field.",
		);

		traceStore.emit("frontend#1", "decision.record", {
			decisionId: decision.id,
			decision: decision.decision,
		}, [], missionId);

		expect(decision.question).toBe("What shape should the /api/users response take?");
		expect(decision.decision).toContain("avatarUrl");
		expect(decision.participants).toContain("frontend#1");
		expect(decision.participants).toContain("backend#1");
		expect(roomManager.getRoom(room.id)!.status).toBe("resolved");
		expect(roomManager.getRoom(room.id)!.turnsUsed).toBe(3);
	});

	it("should make decision records retrievable for late-spawned agents", () => {
		// Simulate a decision that happened before a new agent spawned
		const room = roomManager.open("a#1", "Schema", "What ORM?", ["b#1"], 10);
		const decision = roomManager.resolve(room.id, "Prisma", "Team familiarity");

		// Later agent retrieves it
		const retrieved = roomManager.getDecision(decision.id);
		expect(retrieved).toBeDefined();
		expect(retrieved!.decision).toBe("Prisma");

		// Get all decisions for injection
		const allDecisions = roomManager.getAllDecisions();
		expect(allDecisions).toHaveLength(1);
		expect(allDecisions[0].question).toBe("What ORM?");
	});

	it("should expire rooms and list them for orchestrator arbitration", () => {
		const room = roomManager.open("a#1", "Topic", "Question?", ["b#1"], 3);

		roomManager.recordTurn(room.id); // 1
		roomManager.recordTurn(room.id); // 2
		roomManager.recordTurn(room.id); // 3 — hits budget

		expect(roomManager.getRoom(room.id)!.status).toBe("expired");
		expect(roomManager.getExpiredRooms()).toHaveLength(1);
		expect(roomManager.getExpiredRooms()[0].id).toBe(room.id);
	});

	it("should support multiple concurrent rooms", () => {
		const room1 = roomManager.open("a#1", "Topic 1", "Q1?", ["b#1"], 10);
		const room2 = roomManager.open("a#1", "Topic 2", "Q2?", ["c#1"], 10);

		expect(roomManager.getOpenRooms()).toHaveLength(2);

		roomManager.resolve(room1.id, "Answer 1", "Reason 1");
		expect(roomManager.getOpenRooms()).toHaveLength(1);

		roomManager.resolve(room2.id, "Answer 2", "Reason 2");
		expect(roomManager.getOpenRooms()).toHaveLength(0);
		expect(roomManager.getAllDecisions()).toHaveLength(2);
	});

	it("should track room messages via the message bus", () => {
		const backendInbox: any[] = [];
		messageBus.subscribe("backend#1", (msg) => backendInbox.push(msg));

		const room = roomManager.open("frontend#1", "Contract", "Shape?", ["backend#1"], 10);

		// Frontend sends a proposal to the room (delivered via bus)
		messageBus.send("frontend#1", "backend#1", "PROPOSE", {
			content: "{ id: string }",
			roomId: room.id,
		}, 1, room.id);

		expect(backendInbox).toHaveLength(1);
		expect(backendInbox[0].roomId).toBe(room.id);
		expect(backendInbox[0].type).toBe("PROPOSE");
	});
});

describe("Orchestrator room arbitration", () => {
	let messageBus: MessageBus;
	let roomManager: RoomManager;
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		messageBus = new MessageBus();
		roomManager = new RoomManager(messageBus);
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-arb-trace-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
	});

	afterEach(() => {
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should arbitrate expired rooms via the orchestrator", async () => {
		// Set up repo and catalog for orchestrator
		const repoPath = mkdtempSync(join(tmpdir(), "pi-chorus-arb-"));
		const catalogDir = mkdtempSync(join(tmpdir(), "pi-chorus-arb-catalog-"));

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
			description: "Test arbitration",
			gate: "true",
			repoPath,
			catalogPath: catalogDir,
		}, traceStore);

		// Manually create an expired room on the orchestrator's room manager
		const rm = orchestrator.getRoomManager();
		const room = rm.open("frontend#1", "API Shape", "What format?", ["backend#1"], 2);
		rm.recordTurn(room.id);
		rm.recordTurn(room.id); // Hits budget — now expired

		expect(rm.getExpiredRooms()).toHaveLength(1);

		// Run orchestrator with empty plan — it should arbitrate the expired room
		await orchestrator.run({ mission: "Test", subtasks: [], notes: "" });

		// Room should now be resolved
		expect(rm.getRoom(room.id)!.status).toBe("resolved");
		expect(rm.getRoom(room.id)!.decision).toBeDefined();
		expect(rm.getRoom(room.id)!.decision!.decision).toContain("Orchestrator arbitration");

		// Decision should be retrievable
		const decisions = rm.getAllDecisions();
		expect(decisions).toHaveLength(1);
		expect(decisions[0].rationale).toContain("exhausted its turn budget");

		// Trace should have arbitration events
		const events = traceStore.getEventsByAgent("orchestrator");
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("room.resolve");
		expect(kinds).toContain("decision.record");

		try { execSync("git worktree prune", { cwd: repoPath }); } catch {}
		rmSync(repoPath, { recursive: true, force: true });
		rmSync(catalogDir, { recursive: true, force: true });
	});
});

describe("Decision injection for late-spawned agents", () => {
	it("should format decisions into the agent prompt", () => {
		const decisions: DecisionRecord[] = [
			{
				id: "dec-001",
				roomId: "room-001",
				question: "What database to use?",
				decision: "PostgreSQL with Prisma ORM",
				rationale: "Team familiarity and type safety",
				participants: ["backend#1", "db-migrations#1"],
				dissents: [],
				timestamp: Date.now(),
				causes: [],
			},
			{
				id: "dec-002",
				roomId: "room-002",
				question: "REST or GraphQL?",
				decision: "REST with OpenAPI spec",
				rationale: "Simpler for the current scope, better tooling support",
				participants: ["backend#1", "frontend#1"],
				dissents: [],
				timestamp: Date.now(),
				causes: [],
			},
		];

		// Simulate what AgentRunner does with initialDecisions
		let prompt = "Build the user management API";
		if (decisions.length > 0) {
			const decisionsText = decisions
				.map(
					(d) =>
						`[Decision ${d.id}] Q: ${d.question} → ${d.decision} (${d.rationale}). Participants: ${d.participants.join(", ")}`,
				)
				.join("\n");
			prompt += `\n\n--- Prior Decisions ---\nThe following decisions were made before you were spawned. Act on them:\n${decisionsText}`;
		}

		expect(prompt).toContain("Prior Decisions");
		expect(prompt).toContain("PostgreSQL with Prisma ORM");
		expect(prompt).toContain("REST with OpenAPI spec");
		expect(prompt).toContain("dec-001");
		expect(prompt).toContain("dec-002");
	});
});

describe("Room tracing events", () => {
	let traceStore: TraceStore;
	let contentDir: string;

	beforeEach(() => {
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-roomtrace-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
	});

	afterEach(() => {
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should emit room.open, room.join, room.resolve, and decision.record events", () => {
		const missionId = "trace-test-001";
		const messageBus = new MessageBus();
		const roomManager = new RoomManager(messageBus);

		// Open
		const room = roomManager.open("frontend#1", "Contract", "Shape?", ["backend#1"], 10);
		traceStore.emit("frontend#1", "room.open", {
			roomId: room.id, topic: "Contract",
		}, [], missionId);

		// Join (backend acknowledges)
		traceStore.emit("backend#1", "room.join", {
			roomId: room.id,
		}, [], missionId);

		// Negotiate
		roomManager.recordTurn(room.id);
		roomManager.recordTurn(room.id);

		// Resolve
		const decision = roomManager.resolve(room.id, "{ id, name }", "Agreed");
		traceStore.emit("frontend#1", "room.resolve", {
			roomId: room.id, decisionId: decision.id,
		}, [], missionId);
		traceStore.emit("frontend#1", "decision.record", {
			decisionId: decision.id,
			question: decision.question,
			decision: decision.decision,
		}, [], missionId);

		const events = traceStore.getEventsByMission(missionId);
		const kinds = events.map((e) => e.kind);

		expect(kinds).toContain("room.open");
		expect(kinds).toContain("room.join");
		expect(kinds).toContain("room.resolve");
		expect(kinds).toContain("decision.record");

		// Verify causal ordering
		expect(events[0].clock).toBeLessThan(events[events.length - 1].clock);
	});
});
