import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RoleDefinition } from "@pi-chorus/coordination";

/**
 * Loads role definitions from YAML files in the catalog directory.
 * Roles are static, version-controlled, diffable, and reviewable like any other config.
 *
 * What's emergent is which roles get instantiated, how many, when, and who talks to whom —
 * never the role definitions.
 */
export class RoleCatalog {
	private readonly roles = new Map<string, RoleDefinition>();
	private readonly catalogPath: string;

	constructor(catalogPath: string) {
		this.catalogPath = catalogPath;
	}

	/** Load all role definitions from the catalog directory. */
	load(): RoleDefinition[] {
		const files = readdirSync(this.catalogPath).filter(
			(f) => f.endsWith(".yaml") || f.endsWith(".yml"),
		);

		for (const file of files) {
			const content = readFileSync(join(this.catalogPath, file), "utf-8");
			const raw = parseYaml(content);
			const role = this.parseRole(raw);
			this.roles.set(role.name, role);
		}

		return Array.from(this.roles.values());
	}

	/** Get a role by name. */
	get(name: string): RoleDefinition | undefined {
		return this.roles.get(name);
	}

	/** Get all loaded roles. */
	getAll(): RoleDefinition[] {
		return Array.from(this.roles.values());
	}

	private parseRole(raw: any): RoleDefinition {
		if (!raw.name) throw new Error("Role definition missing 'name'");
		if (!raw.capabilities) throw new Error(`Role '${raw.name}' missing 'capabilities'`);

		return {
			name: raw.name,
			description: raw.description ?? "",
			capabilities: raw.capabilities ?? [],
			systemPrompt: raw.system_prompt ?? "",
			model: raw.model ?? "sonnet",
			tools: raw.tools ?? ["read", "write", "edit", "bash"],
			pathScope: raw.path_scope ?? [],
			localGate: raw.local_gate,
		};
	}
}
