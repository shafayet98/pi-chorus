import { parseArgs } from "node:util";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator, AutoApprover, InteractiveApprover } from "@pi-chorus/orchestrator";
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
			auto: { type: "boolean", default: false },
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

			// Start live viewer first so it's ready for events
			const viewerPort = parseInt(values.port ?? "3000", 10);
			const traceDir = mkdtempSync(join(tmpdir(), "pi-chorus-trace-"));
			const traceDb = createInMemoryDatabase();
			const traceStore = new TraceStore(traceDb, traceDir);
			const viewer = new ViewerServer({ traceStore, port: viewerPort });
			const viewerUrl = await viewer.start();
			console.log(`\n  Live viewer: ${viewerUrl}\n`);

			const config: MissionConfig = {
				description,
				gate: values.gate ?? "echo 'No gate configured'",
				repoPath: values.repo ?? ".",
				catalogPath: values.catalog ?? "./roles",
				maxAgents: values["max-agents"] ? parseInt(values["max-agents"], 10) : undefined,
				onMissionStart: (missionId) => viewer.setMissionId(missionId),
			};

			const approver = values.auto ? new AutoApprover() : new InteractiveApprover();
			const orchestrator = new Orchestrator(config, traceStore, approver);
			const result = await orchestrator.run();

			// Keep viewer running after mission for inspection
			console.log(`\nViewer still running at ${viewerUrl} — press Ctrl+C to stop.`);
			process.on("SIGINT", async () => {
				await viewer.stop();
				process.exit(0);
			});

			// Keep process alive for viewer
			await new Promise(() => {}); // blocks until Ctrl+C
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

		case "list": {
			const listDir = mkdtempSync(join(tmpdir(), "pi-chorus-list-"));
			const listStore = new TraceStore(createInMemoryDatabase(), listDir);
			const missions = listStore.listMissions();

			if (missions.length === 0) {
				console.log("No past missions found.");
				console.log("(Note: mission persistence requires a real SQLite database, not yet implemented.)");
			} else {
				for (const m of missions) {
					const duration = m.endedAt ? `${((m.endedAt - m.startedAt) / 1000).toFixed(1)}s` : "running";
					console.log(`${m.id.slice(0, 8)}  ${m.status.padEnd(10)} ${duration.padEnd(8)} ${m.agentCount} agents  ${m.description.slice(0, 60)}`);
				}
			}
			break;
		}

		default:
			console.log("pi-chorus - Self-organizing multi-agent coding system");
			console.log("");
			console.log("Commands:");
			console.log("  run <description> --gate <cmd>  Run a mission");
			console.log("  view [--port 3000]              Launch trace viewer");
			console.log("  replay <mission-id>             Replay a mission trace");
			console.log("  list                            List past missions");
			console.log("");
			console.log("Options:");
			console.log("  --gate <cmd>       Verification gate (e.g., 'npm test && npm run build')");
			console.log("  --repo <path>      Repository path (default: .)");
			console.log("  --catalog <path>   Role catalog directory (default: ./roles)");
			console.log("  --max-agents <n>   Maximum number of agents");
			console.log("  --auto             Skip interactive approvals (fully autonomous)");
			console.log("  --port <n>         Port for trace viewer (default: 3000)");
			break;
	}
}

// Run when invoked directly
runCli().catch((err) => {
	console.error("Error:", err.message ?? err);
	process.exit(1);
});
