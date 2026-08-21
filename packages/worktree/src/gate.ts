import { execSync } from "node:child_process";
import type { GateResult } from "./types.ts";

/**
 * Verification gate — runs a pipeline of commands against the integration branch.
 * The mission spec defines what must pass. "The agents said they finished" is not
 * a completion condition; the gate is.
 */
export class VerificationGate {
	private readonly commands: string[];

	constructor(commands: string[]) {
		if (commands.length === 0) {
			throw new Error("Verification gate requires at least one command");
		}
		this.commands = commands;
	}

	/** Parse a gate spec like "npm test && npm run build && npm run lint" */
	static fromString(spec: string): VerificationGate {
		const commands = spec
			.split("&&")
			.map((c) => c.trim())
			.filter((c) => c.length > 0);
		return new VerificationGate(commands);
	}

	/** Run all gate commands in sequence. Stops at the first failure. */
	run(cwd: string): GateResult {
		const start = Date.now();
		const outputs: string[] = [];

		for (const command of this.commands) {
			try {
				const output = execSync(command, {
					cwd,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 5 * 60 * 1000, // 5 minute timeout per command
				});
				outputs.push(`$ ${command}\n${output}`);
			} catch (e: any) {
				const output = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
				outputs.push(`$ ${command}\n${output}`);
				return {
					passed: false,
					failedCommand: command,
					output: outputs.join("\n---\n"),
					durationMs: Date.now() - start,
				};
			}
		}

		return {
			passed: true,
			output: outputs.join("\n---\n"),
			durationMs: Date.now() - start,
		};
	}
}
