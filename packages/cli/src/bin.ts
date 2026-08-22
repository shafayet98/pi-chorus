#!/usr/bin/env node
import { runCli } from "./cli.ts";

runCli().catch((err) => {
	console.error("Error:", err.message ?? err);
	process.exit(1);
});
