import type { CapabilityEntry, RoleDefinition } from "./types.ts";

/**
 * Capability registry. Tracks which roles are instantiated and what they own.
 * Agents check it before requesting a spawn; the orchestrator checks it before granting one.
 */
export class CapabilityRegistry {
	private readonly entries = new Map<string, CapabilityEntry>();
	private readonly catalog = new Map<string, RoleDefinition>();

	/** Load the role catalog. */
	loadCatalog(roles: RoleDefinition[]): void {
		for (const role of roles) {
			this.catalog.set(role.name, role);
		}
	}

	/** Register an active agent instance. */
	register(agentId: string, roleName: string, capabilities: string[]): void {
		this.entries.set(agentId, {
			agentId,
			roleName,
			capabilities,
			claimedPaths: [],
			active: true,
		});
	}

	/** Deactivate an agent (on shutdown/crash). */
	deactivate(agentId: string): void {
		const entry = this.entries.get(agentId);
		if (entry) {
			entry.active = false;
		}
	}

	/** Find an active agent that provides a capability. */
	findByCapability(capability: string): CapabilityEntry | undefined {
		for (const entry of this.entries.values()) {
			if (entry.active && entry.capabilities.includes(capability)) {
				return entry;
			}
		}
		return undefined;
	}

	/** Find a role in the catalog that matches a capability. */
	findRoleByCapability(capability: string): RoleDefinition | undefined {
		for (const role of this.catalog.values()) {
			if (role.capabilities.includes(capability)) {
				return role;
			}
		}
		return undefined;
	}

	/** Find the nearest matching role for a capability (partial match). */
	findNearestRole(capability: string): RoleDefinition | undefined {
		// Exact match first
		const exact = this.findRoleByCapability(capability);
		if (exact) return exact;

		// Partial match: check if any role capability contains the requested tag
		for (const role of this.catalog.values()) {
			if (role.capabilities.some((c) => c.includes(capability) || capability.includes(c))) {
				return role;
			}
		}
		return undefined;
	}

	/** Get all active agents. */
	getActiveAgents(): CapabilityEntry[] {
		return Array.from(this.entries.values()).filter((e) => e.active);
	}

	/** Count active agents. */
	getActiveCount(): number {
		return this.getActiveAgents().length;
	}

	/** Generate the next instance ID for a role (e.g., "frontend#2"). */
	nextInstanceId(roleName: string): string {
		let max = 0;
		for (const entry of this.entries.values()) {
			if (entry.roleName === roleName) {
				const match = entry.agentId.match(/#(\d+)$/);
				if (match) {
					max = Math.max(max, parseInt(match[1], 10));
				}
			}
		}
		return `${roleName}#${max + 1}`;
	}

	/** Get a role definition from the catalog. */
	getRole(name: string): RoleDefinition | undefined {
		return this.catalog.get(name);
	}

	/** Get all role definitions. */
	getAllRoles(): RoleDefinition[] {
		return Array.from(this.catalog.values());
	}
}
