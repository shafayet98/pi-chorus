import type { EventKind, TraceEvent } from "./types.ts";
import { ContentStore } from "./content-store.ts";
import { LamportClock } from "./lamport-clock.ts";
import { randomUUID } from "node:crypto";

/**
 * Trace store backed by SQLite for events and a content-addressed blob store for payloads.
 *
 * During a run, events are written as they happen.
 * After a run, the same store is read for replay and debugging.
 *
 * Note: SQLite dependency is injected via the Database interface to keep this
 * module testable without requiring better-sqlite3 at import time.
 */
export interface Database {
	exec(sql: string): void;
	prepare(sql: string): Statement;
}

export interface Statement {
	run(...params: any[]): void;
	all(...params: any[]): any[];
	get(...params: any[]): any;
}

export interface MissionRecord {
	id: string;
	description: string;
	status: string;
	startedAt: number;
	endedAt?: number;
	agentCount: number;
	totalTokens: number;
	gatePassed: boolean;
}

export class TraceStore {
	private readonly db: Database;
	private readonly contentStore: ContentStore;
	private readonly clocks = new Map<string, LamportClock>();
	private readonly listeners: Array<(event: TraceEvent) => void> = [];

	constructor(db: Database, contentStoreDir: string) {
		this.db = db;
		this.contentStore = new ContentStore(contentStoreDir);
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id TEXT PRIMARY KEY,
				clock INTEGER NOT NULL,
				agent_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				causes TEXT NOT NULL,
				payload_hash TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				mission_id TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
			CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
			CREATE INDEX IF NOT EXISTS idx_events_mission ON events(mission_id);
			CREATE INDEX IF NOT EXISTS idx_events_clock ON events(clock);
		`);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS missions (
				id TEXT PRIMARY KEY,
				description TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				agent_count INTEGER NOT NULL DEFAULT 0,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				gate_passed INTEGER NOT NULL DEFAULT 0
			);
		`);
	}

	/** Save or update a mission record. */
	saveMission(mission: MissionRecord): void {
		// Upsert: try insert, if exists update
		// Our in-memory DB doesn't support ON CONFLICT, so delete + insert
		try {
			this.db.prepare("DELETE FROM missions WHERE id = ?").run(mission.id);
		} catch {
			// Table might not support delete in some implementations
		}
		this.db.prepare(
			"INSERT INTO missions (id, description, status, started_at, ended_at, agent_count, total_tokens, gate_passed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			mission.id,
			mission.description,
			mission.status,
			mission.startedAt,
			mission.endedAt ?? null,
			mission.agentCount,
			mission.totalTokens,
			mission.gatePassed ? 1 : 0,
		);
	}

	/** Get all missions, most recent first. */
	listMissions(): MissionRecord[] {
		const rows = this.db.prepare("SELECT * FROM missions").all();
		// Sort in JS since in-memory DB may not support ORDER BY
		rows.sort((a: any, b: any) => (b.started_at ?? 0) - (a.started_at ?? 0));
		return rows.map((r: any) => ({
			id: r.id,
			description: r.description,
			status: r.status,
			startedAt: r.started_at,
			endedAt: r.ended_at,
			agentCount: r.agent_count,
			totalTokens: r.total_tokens,
			gatePassed: r.gate_passed === 1,
		}));
	}

	/** Get a single mission record. */
	getMission(id: string): MissionRecord | null {
		const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id);
		if (!row) return null;
		return {
			id: (row as any).id,
			description: (row as any).description,
			status: (row as any).status,
			startedAt: (row as any).started_at,
			endedAt: (row as any).ended_at,
			agentCount: (row as any).agent_count,
			totalTokens: (row as any).total_tokens,
			gatePassed: (row as any).gate_passed === 1,
		};
	}

	/** Get or create a Lamport clock for an agent. */
	clockFor(agentId: string): LamportClock {
		let clock = this.clocks.get(agentId);
		if (!clock) {
			clock = new LamportClock();
			this.clocks.set(agentId, clock);
		}
		return clock;
	}

	/** Emit a trace event. Stores the payload, writes the event, and notifies listeners. */
	emit(agentId: string, kind: EventKind, payload: unknown, causes: string[], missionId: string): TraceEvent {
		const clock = this.clockFor(agentId);
		const clockValue = clock.tick();
		const payloadHash = this.contentStore.put(JSON.stringify(payload));
		const event: TraceEvent = {
			id: randomUUID(),
			clock: clockValue,
			agentId,
			kind,
			causes,
			payloadHash,
			timestamp: Date.now(),
			missionId,
		};
		this.writeEvent(event);
		for (const listener of this.listeners) {
			listener(event);
		}
		return event;
	}

	/** Subscribe to live events. Returns an unsubscribe function. */
	onEvent(listener: (event: TraceEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	/** Query events by mission ID, ordered by Lamport clock. */
	getEventsByMission(missionId: string): TraceEvent[] {
		const rows = this.db
			.prepare("SELECT * FROM events WHERE mission_id = ? ORDER BY clock ASC")
			.all(missionId);
		return rows.map((r: any) => this.rowToEvent(r));
	}

	/** Query events by agent ID, ordered by Lamport clock. */
	getEventsByAgent(agentId: string): TraceEvent[] {
		const rows = this.db.prepare("SELECT * FROM events WHERE agent_id = ? ORDER BY clock ASC").all(agentId);
		return rows.map((r: any) => this.rowToEvent(r));
	}

	/** Get a single event by ID. */
	getEvent(id: string): TraceEvent | null {
		const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id);
		return row ? this.rowToEvent(row) : null;
	}

	/** Retrieve the payload for a given content hash. */
	getPayload(hash: string): unknown | null {
		const buf = this.contentStore.get(hash);
		if (!buf) return null;
		return JSON.parse(buf.toString("utf-8"));
	}

	/** Walk the causal chain backward from an event. */
	getCausalChain(eventId: string): TraceEvent[] {
		const result: TraceEvent[] = [];
		const visited = new Set<string>();
		const queue = [eventId];
		while (queue.length > 0) {
			const id = queue.shift()!;
			if (visited.has(id)) continue;
			visited.add(id);
			const event = this.getEvent(id);
			if (event) {
				result.push(event);
				queue.push(...event.causes);
			}
		}
		return result;
	}

	private writeEvent(event: TraceEvent): void {
		this.db
			.prepare(
				"INSERT INTO events (id, clock, agent_id, kind, causes, payload_hash, timestamp, mission_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				event.id,
				event.clock,
				event.agentId,
				event.kind,
				JSON.stringify(event.causes),
				event.payloadHash,
				event.timestamp,
				event.missionId,
			);
	}

	private rowToEvent(row: any): TraceEvent {
		return {
			id: row.id,
			clock: row.clock,
			agentId: row.agent_id,
			kind: row.kind as EventKind,
			causes: JSON.parse(row.causes),
			payloadHash: row.payload_hash,
			timestamp: row.timestamp,
			missionId: row.mission_id,
		};
	}
}

/**
 * In-memory Database implementation for testing and lightweight usage.
 * Implements the same query interface as SQLite but stores everything in arrays.
 */
export function createInMemoryDatabase(): Database {
	const tables = new Map<string, any[]>();

	return {
		exec(sql: string): void {
			const createMatch = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
			if (createMatch && !tables.has(createMatch[1])) {
				tables.set(createMatch[1], []);
			}
		},
		prepare(sql: string): Statement {
			return {
				run(...params: any[]): void {
					const insertMatch = sql.match(/INSERT INTO (\w+)/);
					if (insertMatch) {
						const table = tables.get(insertMatch[1]);
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
					const table = tables.get(selectMatch[1]) ?? [];
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
		},
	};
}
