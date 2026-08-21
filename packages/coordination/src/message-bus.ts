import { randomUUID } from "node:crypto";
import type { AgentMessage, MessageType } from "./types.ts";

type MessageHandler = (message: AgentMessage) => void;

/**
 * Typed message bus for agent-to-agent communication.
 * DMs by default — send("frontend#1", ...) reaches frontend#1 and nobody else.
 */
export class MessageBus {
	private readonly handlers = new Map<string, MessageHandler[]>();
	private readonly allHandlers: Array<(message: AgentMessage) => void> = [];

	/** Register a handler for messages addressed to a specific agent. */
	subscribe(agentId: string, handler: MessageHandler): () => void {
		const handlers = this.handlers.get(agentId) ?? [];
		handlers.push(handler);
		this.handlers.set(agentId, handlers);
		return () => {
			const idx = handlers.indexOf(handler);
			if (idx >= 0) handlers.splice(idx, 1);
		};
	}

	/** Subscribe to all messages on the bus (for tracing). */
	subscribeAll(handler: (message: AgentMessage) => void): () => void {
		this.allHandlers.push(handler);
		return () => {
			const idx = this.allHandlers.indexOf(handler);
			if (idx >= 0) this.allHandlers.splice(idx, 1);
		};
	}

	/** Send a typed message to a specific agent. */
	send(from: string, to: string, type: MessageType, payload: unknown, clock: number, roomId?: string): AgentMessage {
		const message: AgentMessage = {
			id: randomUUID(),
			from,
			to,
			type,
			payload,
			clock,
			timestamp: Date.now(),
			roomId,
		};

		// Deliver to target agent's handlers
		const handlers = this.handlers.get(to);
		if (handlers) {
			for (const handler of handlers) {
				handler(message);
			}
		}

		// Deliver to global observers (tracing)
		for (const handler of this.allHandlers) {
			handler(message);
		}

		return message;
	}

	/** Check if an agent has any registered handlers. */
	hasSubscribers(agentId: string): boolean {
		const handlers = this.handlers.get(agentId);
		return handlers !== undefined && handlers.length > 0;
	}

	/** Remove all handlers for an agent (on agent shutdown). */
	unsubscribeAll(agentId: string): void {
		this.handlers.delete(agentId);
	}
}
