import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceStore } from "@pi-chorus/trace";
import type { TraceEvent } from "@pi-chorus/trace";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export interface ViewerOptions {
	traceStore: TraceStore;
	port?: number;
	/** If true, don't actually start listening (for testing) */
	dryRun?: boolean;
}

/**
 * Local web server for viewing pi-chorus traces.
 *
 * Serves a REST API for events/payloads and a vanilla HTML/JS frontend.
 * Supports Server-Sent Events (SSE) for live streaming during a run.
 * No external dependencies — just Node's built-in http module.
 */
export class ViewerServer {
	private readonly traceStore: TraceStore;
	private readonly port: number;
	private server: ReturnType<typeof createServer> | null = null;
	private readonly sseClients: Set<ServerResponse> = new Set();
	private unsubscribeTrace?: () => void;
	private currentMissionId: string | null = null;

	constructor(options: ViewerOptions) {
		this.traceStore = options.traceStore;
		this.port = options.port ?? 3000;

		if (!options.dryRun) {
			this.setupLiveStreaming();
		}
	}

	/** Set the active mission ID (auto-shown in the frontend). */
	setMissionId(missionId: string): void {
		this.currentMissionId = missionId;
		// Notify all SSE clients of the new mission
		this.broadcast({ type: "mission", missionId });
	}

	/** Start the server. */
	async start(): Promise<string> {
		return new Promise((resolve) => {
			this.server = createServer((req, res) => this.handleRequest(req, res));
			this.server.listen(this.port, () => {
				const url = `http://localhost:${this.port}`;
				resolve(url);
			});
		});
	}

	/** Stop the server. */
	async stop(): Promise<void> {
		this.unsubscribeTrace?.();
		for (const client of this.sseClients) {
			client.end();
		}
		this.sseClients.clear();
		return new Promise((resolve) => {
			if (this.server) {
				this.server.close(() => resolve());
			} else {
				resolve();
			}
		});
	}

	/** Handle an HTTP request (exposed for testing without starting the server). */
	handleRequest(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
		const path = url.pathname;

		// CORS headers
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET");

		// SSE endpoint
		if (path === "/api/stream") {
			this.handleSSE(res);
			return;
		}

		// Current mission ID
		if (path === "/api/current-mission") {
			this.json(res, 200, { missionId: this.currentMissionId });
			return;
		}

		// API routes
		if (path.startsWith("/api/")) {
			this.handleApi(path, url, res);
			return;
		}

		// Static files
		this.serveStatic(path, res);
	}

	private handleSSE(res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		// Send current mission ID immediately
		if (this.currentMissionId) {
			res.write(`data: ${JSON.stringify({ type: "mission", missionId: this.currentMissionId })}\n\n`);
		}

		this.sseClients.add(res);

		res.on("close", () => {
			this.sseClients.delete(res);
		});
	}

	private broadcast(data: unknown): void {
		const message = `data: ${JSON.stringify(data)}\n\n`;
		for (const client of this.sseClients) {
			client.write(message);
		}
	}

	private handleApi(path: string, url: URL, res: ServerResponse): void {
		try {
			if (path === "/api/missions") {
				this.handleMissions(res);
			} else if (path.startsWith("/api/events/")) {
				const missionId = path.slice("/api/events/".length);
				this.handleEvents(missionId, url, res);
			} else if (path.startsWith("/api/agents/")) {
				const agentId = decodeURIComponent(path.slice("/api/agents/".length));
				this.handleAgentEvents(agentId, res);
			} else if (path.startsWith("/api/payload/")) {
				const hash = path.slice("/api/payload/".length);
				this.handlePayload(hash, res);
			} else if (path.startsWith("/api/causal-chain/")) {
				const eventId = path.slice("/api/causal-chain/".length);
				this.handleCausalChain(eventId, res);
			} else if (path.startsWith("/api/replay/")) {
				const missionId = path.slice("/api/replay/".length);
				this.handleReplay(missionId, res);
			} else if (path.startsWith("/api/roster/")) {
				const missionId = path.slice("/api/roster/".length);
				this.handleRoster(missionId, res);
			} else if (path.startsWith("/api/swimlanes/")) {
				const missionId = path.slice("/api/swimlanes/".length);
				this.handleSwimlanes(missionId, res);
			} else {
				this.json(res, 404, { error: "Not found" });
			}
		} catch (e: any) {
			this.json(res, 500, { error: e.message });
		}
	}

	private handleMissions(res: ServerResponse): void {
		const missions = this.traceStore.listMissions();
		this.json(res, 200, { missions });
	}

	private handleEvents(missionId: string, url: URL, res: ServerResponse): void {
		const events = this.traceStore.getEventsByMission(missionId);

		const kind = url.searchParams.get("kind");
		const agentId = url.searchParams.get("agent");

		let filtered = events;
		if (kind) {
			filtered = filtered.filter((e) => e.kind === kind);
		}
		if (agentId) {
			filtered = filtered.filter((e) => e.agentId === agentId);
		}

		this.json(res, 200, { events: filtered });
	}

	private handleAgentEvents(agentId: string, res: ServerResponse): void {
		const events = this.traceStore.getEventsByAgent(agentId);
		this.json(res, 200, { events });
	}

	private handlePayload(hash: string, res: ServerResponse): void {
		const payload = this.traceStore.getPayload(hash);
		if (payload === null) {
			this.json(res, 404, { error: "Payload not found" });
			return;
		}
		this.json(res, 200, { payload });
	}

	private handleCausalChain(eventId: string, res: ServerResponse): void {
		const chain = this.traceStore.getCausalChain(eventId);
		this.json(res, 200, { chain });
	}

	private handleReplay(missionId: string, res: ServerResponse): void {
		const events = this.traceStore.getEventsByMission(missionId);
		const enriched = events.map((event) => ({
			...event,
			payload: this.traceStore.getPayload(event.payloadHash),
		}));
		this.json(res, 200, { events: enriched });
	}

	private handleRoster(missionId: string, res: ServerResponse): void {
		const events = this.traceStore.getEventsByMission(missionId);
		const spawnEvents = events.filter((e) => e.kind === "agent.spawn");

		const roster = spawnEvents.map((event) => {
			const payload = this.traceStore.getPayload(event.payloadHash) as any;
			return {
				agentId: payload?.agentId ?? event.agentId,
				roleName: payload?.roleName ?? "unknown",
				spawnedAt: event.timestamp,
				spawnClock: event.clock,
				mandate: payload?.mandate ?? "",
				spawnEventId: event.id,
			};
		});

		this.json(res, 200, { roster });
	}

	private handleSwimlanes(missionId: string, res: ServerResponse): void {
		const events = this.traceStore.getEventsByMission(missionId);

		const lanes = new Map<string, TraceEvent[]>();
		for (const event of events) {
			const existing = lanes.get(event.agentId) ?? [];
			existing.push(event);
			lanes.set(event.agentId, existing);
		}

		const swimlanes = Array.from(lanes.entries()).map(([agentId, agentEvents]) => ({
			agentId,
			events: agentEvents,
		}));

		this.json(res, 200, { swimlanes });
	}

	private serveStatic(path: string, res: ServerResponse): void {
		const filePath = path === "/" ? "/index.html" : path;
		const publicDir = join(__dirname, "public");
		const fullPath = join(publicDir, filePath);

		try {
			const content = readFileSync(fullPath, "utf-8");
			const ext = extname(filePath);
			const contentType =
				ext === ".html"
					? "text/html"
					: ext === ".js"
						? "application/javascript"
						: ext === ".css"
							? "text/css"
							: "text/plain";

			res.writeHead(200, { "Content-Type": contentType });
			res.end(content);
		} catch {
			this.json(res, 404, { error: "Not found" });
		}
	}

	private json(res: ServerResponse, status: number, data: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	}

	private setupLiveStreaming(): void {
		this.unsubscribeTrace = this.traceStore.onEvent((event) => {
			// Stream every event to connected SSE clients
			const payload = this.traceStore.getPayload(event.payloadHash);
			this.broadcast({
				type: "event",
				event: { ...event, payload },
			});
		});
	}
}
