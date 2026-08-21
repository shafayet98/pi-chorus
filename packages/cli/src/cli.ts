import { parseArgs } from "node:util";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator } from "@pi-chorus/orchestrator";
import type { MissionConfig } from "@pi-chorus/orchestrator";
import { TraceStore, createInMemoryDatabase } from "@pi-chorus/trace";
import { ViewerServer } from "@pi-chorus/viewer";

/**
 * CLI entry point for pi-chorus.
 *
 * Usage:
 *   pi-chorus run "Build a todo app" --gate "npm test && npm run build"
 *   pi-chorus replay <mission-id>
 *   pi-chorus view [--port 3000]
 *   pi-chorus list
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			gate: { type: "string" },
			repo: { type: "string", default: "." },
			catalog: { type: "string", default: "./roles" },
			port: { type: "string", default: "3000" },
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

		case "view": {
			// TODO: Connect to a persisted trace store (SQLite)
			const traceDir = mkdtempSync(join(tmpdir(), "pi-chorus-view-"));
			const traceStore = new TraceStore(createInMemoryDatabase(), traceDir);
			const port = parseInt(values.port ?? "3000", 10);

			const viewer = new ViewerServer({ traceStore, port });
			const url = await viewer.start();
			console.log(`Trace viewer running at ${url}`);
			console.log("Press Ctrl+C to stop.");

			// Keep the process alive
			process.on("SIGINT", async () => {
				await viewer.stop();
				process.exit(0);
			});
			break;
		}

		case "replay": {
			const missionId = positionals[1];
			if (!missionId) {
				console.error("Usage: pi-chorus replay <mission-id>");
				process.exit(1);
			}

			// TODO: Connect to a persisted trace store
			const traceDir = mkdtempSync(join(tmpdir(), "pi-chorus-replay-"));
			const traceStore = new TraceStore(createInMemoryDatabase(), traceDir);

			const events = traceStore.getEventsByMission(missionId);
			if (events.length === 0) {
				console.log(`No events found for mission ${missionId}`);
				break;
			}

			for (const event of events) {
				const payload = traceStore.getPayload(event.payloadHash);
				console.log(JSON.stringify({
					clock: event.clock,
					agent: event.agentId,
					kind: event.kind,
					causes: event.causes,
					payload,
				}));
			}
			break;
		}

		case "list":
			console.log("TODO: List past missions from trace store");
			break;

		default:
			console.log("pi-chorus - Self-organizing multi-agent coding system");
			console.log("");
			console.log("Commands:");
			console.log('  run <description> --gate <cmd>  Run a mission');
			console.log("  view [--port 3000]              Launch trace viewer");
			console.log("  replay <mission-id>             Replay a mission trace");
			console.log("  list                            List past missions");
			break;
	}
}
