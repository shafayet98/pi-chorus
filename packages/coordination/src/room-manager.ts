import { randomUUID } from "node:crypto";
import type { DecisionRecord, Room, AgentMessage } from "./types.ts";
import type { MessageBus } from "./message-bus.ts";

/**
 * Manages ephemeral rooms for multi-party negotiation.
 * Rooms are opened with a stated question, bounded membership, and a turn budget.
 * When resolved, they produce a decision record that outlives the room.
 */
export class RoomManager {
	private readonly rooms = new Map<string, Room>();
	private readonly messageBus: MessageBus;
	private readonly decisions = new Map<string, DecisionRecord>();

	constructor(messageBus: MessageBus) {
		this.messageBus = messageBus;
	}

	/** Open a new room. Returns the room ID. */
	open(askerId: string, topic: string, question: string, invite: string[], turnBudget = 10): Room {
		const room: Room = {
			id: randomUUID(),
			topic,
			question,
			askerId,
			members: [askerId, ...invite],
			status: "open",
			turnBudget,
			turnsUsed: 0,
		};
		this.rooms.set(room.id, room);
		return room;
	}

	/** Record a turn in a room. Returns true if the room is still within budget. */
	recordTurn(roomId: string): boolean {
		const room = this.rooms.get(roomId);
		if (!room || room.status !== "open") return false;
		room.turnsUsed++;
		if (room.turnsUsed >= room.turnBudget) {
			room.status = "expired";
			return false;
		}
		return true;
	}

	/** Resolve a room with a decision. */
	resolve(
		roomId: string,
		decision: string,
		rationale: string,
		dissents: string[] = [],
		causes: string[] = [],
	): DecisionRecord {
		const room = this.rooms.get(roomId);
		if (!room) {
			throw new Error(`Room ${roomId} not found`);
		}

		const record: DecisionRecord = {
			id: randomUUID(),
			roomId,
			question: room.question,
			decision,
			rationale,
			participants: room.members,
			dissents,
			timestamp: Date.now(),
			causes,
		};

		room.status = "resolved";
		room.decision = record;
		this.decisions.set(record.id, record);
		return record;
	}

	/** Invite an additional agent to a room. */
	invite(roomId: string, agentId: string): void {
		const room = this.rooms.get(roomId);
		if (!room || room.status !== "open") return;
		if (!room.members.includes(agentId)) {
			room.members.push(agentId);
		}
	}

	/** Get a room by ID. */
	getRoom(roomId: string): Room | undefined {
		return this.rooms.get(roomId);
	}

	/** Get a decision record by ID. */
	getDecision(decisionId: string): DecisionRecord | undefined {
		return this.decisions.get(decisionId);
	}

	/** Get all decisions. */
	getAllDecisions(): DecisionRecord[] {
		return Array.from(this.decisions.values());
	}

	/** Get rooms that have expired (hit turn budget without resolution). */
	getExpiredRooms(): Room[] {
		return Array.from(this.rooms.values()).filter((r) => r.status === "expired");
	}

	/** Get all open rooms. */
	getOpenRooms(): Room[] {
		return Array.from(this.rooms.values()).filter((r) => r.status === "open");
	}
}
