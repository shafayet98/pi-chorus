import { minimatch } from "minimatch";
import type { Lease, RoleDefinition } from "./types.ts";

/**
 * File-path lease manager. Agents must claim files before writing.
 * Claims are validated against the role's path scope and checked for overlaps.
 *
 * Path scope is what makes leases safe: a frontend agent can't claim migrations/
 * in the first place.
 */
export class LeaseManager {
	private readonly leases = new Map<string, Lease>();
	private readonly roleScopes = new Map<string, string[]>();

	/** Register a role's path scope for validation. */
	registerRole(roleName: string, pathScope: string[]): void {
		this.roleScopes.set(roleName, pathScope);
	}

	/**
	 * Attempt to claim paths for an agent.
	 * Returns the paths that could not be claimed (already held by another agent).
	 */
	claim(agentId: string, roleName: string, paths: string[]): { granted: string[]; denied: string[] } {
		const scope = this.roleScopes.get(roleName);
		const granted: string[] = [];
		const denied: string[] = [];

		for (const path of paths) {
			// Check path scope
			if (scope && !this.isInScope(path, scope)) {
				denied.push(path);
				continue;
			}

			// Check for overlapping claims
			if (this.isClaimedByOther(path, agentId)) {
				denied.push(path);
				continue;
			}

			granted.push(path);
		}

		if (granted.length > 0) {
			const existing = this.leases.get(agentId);
			if (existing) {
				existing.paths.push(...granted);
			} else {
				this.leases.set(agentId, {
					agentId,
					paths: granted,
					grantedAt: Date.now(),
				});
			}
		}

		return { granted, denied };
	}

	/** Release all leases held by an agent. */
	release(agentId: string): string[] {
		const lease = this.leases.get(agentId);
		if (!lease) return [];
		const released = lease.paths;
		this.leases.delete(agentId);
		return released;
	}

	/** Release specific paths held by an agent. */
	releasePaths(agentId: string, paths: string[]): void {
		const lease = this.leases.get(agentId);
		if (!lease) return;
		lease.paths = lease.paths.filter((p) => !paths.includes(p));
		if (lease.paths.length === 0) {
			this.leases.delete(agentId);
		}
	}

	/** Check if a path is writable by an agent (must be claimed by them). */
	canWrite(agentId: string, path: string): boolean {
		const lease = this.leases.get(agentId);
		if (!lease) return false;
		return lease.paths.some((claimed) => path === claimed || path.startsWith(claimed + "/"));
	}

	/** Get who holds the lease for a path. */
	getHolder(path: string): string | null {
		for (const [agentId, lease] of this.leases) {
			if (lease.paths.some((claimed) => path === claimed || path.startsWith(claimed + "/"))) {
				return agentId;
			}
		}
		return null;
	}

	/** Get all current leases. */
	getAllLeases(): Lease[] {
		return Array.from(this.leases.values());
	}

	private isInScope(path: string, scope: string[]): boolean {
		return scope.some((pattern) => minimatch(path, pattern));
	}

	private isClaimedByOther(path: string, agentId: string): boolean {
		for (const [holderId, lease] of this.leases) {
			if (holderId === agentId) continue;
			if (lease.paths.some((claimed) => path === claimed || path.startsWith(claimed + "/") || claimed.startsWith(path + "/"))) {
				return true;
			}
		}
		return false;
	}
}
