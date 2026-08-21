import { parseArgs } from "node:util";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator } from "@pi-chorus/orchestrator";
import type { MissionConfig } from "@pi-chorus/orchestrator";
import { TraceStore, createInMemoryDatabase } from "@pi-chorus/trace";

/**
 * CLI entry point for pi-chorus.
 *
 * Usage:
 *   pi-chorus run "Build a todo app" --gate "npm test && npm run build"
 *   pi-chorus replay <mission-id>
 *   pi-chorus view <mission-id>
 *   pi-chorus list
 *
 * TODO: This is a scaffold. Full implementation will add:
 * - TUI with live agent status
 * - Trace replay
 * - Local web viewer launch
 * - Human-in-the-loop approval flow
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			gate: { type: "string" },
			repo: { type: "string", default: "." },
			catalog: { type: "string", default: "./roles" },
			"max-agents": { type: "string" },
			"human-approval": { type: "boolean", default: true },
		},
	});

	const command = positionals[0];

	switch (command) {
		case "run": {
			const description = positionals[1];
			if (!description) {
				console.error("Usage: pi-chorus run <description> --gate <command>");
				process.exit(1);
			}

			const config: MissionConfig = {
				description,
				gate: values.gate ?? "echo 'No gate configured'",
				repoPath: values.repo ?? ".",
				catalogPath: values.catalog ?? "./roles",
				maxAgents: values["max-agents"] ? parseInt(values["max-agents"], 10) : undefined,
				humanApproval: values["human-approval"],
			};

			// TODO: Use real SQLite for trace store
			const traceDir = mkdtempSync(join(tmpdir(), "pi-chorus-trace-"));
			const traceDb = createInMemoryDatabase();
			const traceStore = new TraceStore(traceDb, traceDir);

			const orchestrator = new Orchestrator(config, traceStore);
			const result = await orchestrator.run();

			console.log(`Mission ${result.mission.id}: ${result.mission.status}`);
			console.log(`Gate: ${result.gatePassed ? "PASSED" : "NOT RUN"}`);
			console.log(`Time: ${result.wallTimeMs}ms`);
			console.log(`Tokens: ${result.totalTokens}`);
			break;
		}

		case "list":
			console.log("TODO: List past missions from trace store");
			break;

		case "replay":
			console.log("TODO: Replay mission from trace store");
			break;

		case "view":
			console.log("TODO: Launch local web viewer");
			break;

		default:
			console.log("pi-chorus - Self-organizing multi-agent coding system");
			console.log("");
			console.log("Commands:");
			console.log('  run <description> --gate <cmd>  Run a mission');
			console.log("  list                            List past missions");
			console.log("  replay <mission-id>             Replay a mission trace");
			console.log("  view <mission-id>               Open trace viewer");
			break;
	}
}
