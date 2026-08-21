import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

import { TraceStore, createInMemoryDatabase } from "@pi-chorus/trace";
import { ViewerServer } from "../src/server.ts";

function fetch(url: string): Promise<{ status: number; body: any }> {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => {
			let data = "";
			res.on("data", (chunk) => { data += chunk; });
			res.on("end", () => {
				try {
					resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
				} catch {
					resolve({ status: res.statusCode ?? 0, body: data });
				}
			});
		}).on("error", reject);
	});
}

describe("ViewerServer API", () => {
	let traceStore: TraceStore;
	let contentDir: string;
	let server: ViewerServer;
	let baseUrl: string;

	beforeEach(async () => {
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-viewer-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);

		// Seed some test data
		traceStore.emit("orchestrator", "agent.spawn", { agentId: "backend#1", roleName: "backend", mandate: "Build API" }, [], "mission-1");
		traceStore.emit("orchestrator", "agent.spawn", { agentId: "frontend#1", roleName: "frontend", mandate: "Build UI" }, [], "mission-1");
		traceStore.emit("backend#1", "lifecycle.start", { role: "backend" }, [], "mission-1");
		traceStore.emit("backend#1", "tool.start", { toolName: "write", args: { path: "src/api.ts" } }, [], "mission-1");
		traceStore.emit("backend#1", "tool.end", { toolName: "write", isError: false }, [], "mission-1");
		traceStore.emit("backend#1", "lifecycle.stop", { status: "done" }, [], "mission-1");
		traceStore.emit("frontend#1", "lifecycle.start", { role: "frontend" }, [], "mission-1");
		traceStore.emit("frontend#1", "lifecycle.stop", { status: "done" }, [], "mission-1");
		traceStore.emit("orchestrator", "gate.pass", { durationMs: 42 }, [], "mission-1");

		// Use a random port to avoid conflicts
		const port = 30000 + Math.floor(Math.random() * 10000);
		server = new ViewerServer({ traceStore, port });
		baseUrl = await server.start();
	});

	afterEach(async () => {
		await server.stop();
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should return events for a mission", async () => {
		const res = await fetch(`${baseUrl}/api/events/mission-1`);
		expect(res.status).toBe(200);
		expect(res.body.events.length).toBe(9);
	});

	it("should filter events by kind", async () => {
		const res = await fetch(`${baseUrl}/api/events/mission-1?kind=agent.spawn`);
		expect(res.status).toBe(200);
		expect(res.body.events.length).toBe(2);
		expect(res.body.events.every((e: any) => e.kind === "agent.spawn")).toBe(true);
	});

	it("should filter events by agent", async () => {
		const res = await fetch(`${baseUrl}/api/events/mission-1?agent=backend%231`);
		expect(res.status).toBe(200);
		expect(res.body.events.length).toBe(4); // start, tool.start, tool.end, stop
		expect(res.body.events.every((e: any) => e.agentId === "backend#1")).toBe(true);
	});

	it("should return events for an agent", async () => {
		const res = await fetch(`${baseUrl}/api/agents/backend%231`);
		expect(res.status).toBe(200);
		expect(res.body.events.length).toBe(4);
	});

	it("should return a payload by hash", async () => {
		const events = traceStore.getEventsByMission("mission-1");
		const spawnEvent = events.find((e) => e.kind === "agent.spawn")!;

		const res = await fetch(`${baseUrl}/api/payload/${spawnEvent.payloadHash}`);
		expect(res.status).toBe(200);
		expect(res.body.payload).toBeDefined();
		expect(res.body.payload.agentId).toBe("backend#1");
	});

	it("should return 404 for missing payload", async () => {
		const res = await fetch(`${baseUrl}/api/payload/nonexistent-hash`);
		expect(res.status).toBe(404);
	});

	it("should return the causal chain for an event", async () => {
		// Create events with causes
		const e1 = traceStore.emit("test", "lifecycle.start", {}, [], "mission-2");
		const e2 = traceStore.emit("test", "tool.start", {}, [e1.id], "mission-2");
		const e3 = traceStore.emit("test", "tool.end", {}, [e2.id], "mission-2");

		const res = await fetch(`${baseUrl}/api/causal-chain/${e3.id}`);
		expect(res.status).toBe(200);
		expect(res.body.chain.length).toBe(3);
	});

	it("should return swimlanes grouped by agent", async () => {
		const res = await fetch(`${baseUrl}/api/swimlanes/mission-1`);
		expect(res.status).toBe(200);

		const lanes = res.body.swimlanes;
		expect(lanes.length).toBe(3); // orchestrator, backend#1, frontend#1

		const agentIds = lanes.map((l: any) => l.agentId).sort();
		expect(agentIds).toContain("orchestrator");
		expect(agentIds).toContain("backend#1");
		expect(agentIds).toContain("frontend#1");
	});

	it("should return roster timeline with spawn info", async () => {
		const res = await fetch(`${baseUrl}/api/roster/mission-1`);
		expect(res.status).toBe(200);

		const roster = res.body.roster;
		expect(roster.length).toBe(2); // backend#1, frontend#1

		const backend = roster.find((r: any) => r.agentId === "backend#1");
		expect(backend).toBeDefined();
		expect(backend.roleName).toBe("backend");
		expect(backend.mandate).toBe("Build API");
	});

	it("should return replay with resolved payloads", async () => {
		const res = await fetch(`${baseUrl}/api/replay/mission-1`);
		expect(res.status).toBe(200);

		const events = res.body.events;
		expect(events.length).toBe(9);

		// Every event should have a resolved payload
		for (const event of events) {
			expect(event.payload).toBeDefined();
		}

		// Verify specific payload content
		const spawnEvent = events.find((e: any) => e.kind === "agent.spawn");
		expect(spawnEvent.payload.agentId).toBe("backend#1");
	});

	it("should return empty results for unknown mission", async () => {
		const res = await fetch(`${baseUrl}/api/events/nonexistent`);
		expect(res.status).toBe(200);
		expect(res.body.events).toHaveLength(0);
	});

	it("should return 404 for unknown API routes", async () => {
		const res = await fetch(`${baseUrl}/api/unknown`);
		expect(res.status).toBe(404);
	});
});

describe("ViewerServer static serving", () => {
	let traceStore: TraceStore;
	let contentDir: string;
	let server: ViewerServer;
	let baseUrl: string;

	beforeEach(async () => {
		contentDir = mkdtempSync(join(tmpdir(), "pi-chorus-static-"));
		traceStore = new TraceStore(createInMemoryDatabase(), contentDir);
		const port = 30000 + Math.floor(Math.random() * 10000);
		server = new ViewerServer({ traceStore, port });
		baseUrl = await server.start();
	});

	afterEach(async () => {
		await server.stop();
		rmSync(contentDir, { recursive: true, force: true });
	});

	it("should serve index.html at /", async () => {
		const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			http.get(`${baseUrl}/`, (r) => {
				let data = "";
				r.on("data", (chunk) => { data += chunk; });
				r.on("end", () => resolve({ status: r.statusCode ?? 0, body: data }));
			}).on("error", reject);
		});

		expect(res.status).toBe(200);
		expect(res.body).toContain("pi-chorus");
		expect(res.body).toContain("trace viewer");
	});
});
