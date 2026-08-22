/**
 * Real-time mission logger. Prints colored, timestamped updates
 * so you can see exactly what's happening during a run.
 */

const COLORS = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	blue: "\x1b[34m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
	bgGreen: "\x1b[42m",
	bgRed: "\x1b[41m",
	bgYellow: "\x1b[43m",
	bgBlue: "\x1b[44m",
};

function timestamp(): string {
	const now = new Date();
	return `${COLORS.gray}${now.toLocaleTimeString()}${COLORS.reset}`;
}

function padRight(str: string, len: number): string {
	return str.length >= len ? str : str + " ".repeat(len - str.length);
}

export class MissionLogger {
	private startTime = Date.now();

	elapsed(): string {
		const ms = Date.now() - this.startTime;
		const s = Math.floor(ms / 1000);
		const m = Math.floor(s / 60);
		const remaining = s % 60;
		return `${COLORS.gray}${m}m${remaining.toString().padStart(2, "0")}s${COLORS.reset}`;
	}

	mission(id: string, description: string): void {
		console.log("");
		console.log(`${COLORS.bold}${COLORS.blue}━━━ MISSION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
		console.log(`${COLORS.gray}ID:${COLORS.reset}   ${id}`);
		console.log(`${COLORS.gray}Task:${COLORS.reset} ${description}`);
		console.log(`${COLORS.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
		console.log("");
		this.startTime = Date.now();
	}

	catalog(roleCount: number, roleNames: string[]): void {
		console.log(`${timestamp()} ${COLORS.cyan}📋 Catalog${COLORS.reset} loaded ${roleCount} roles: ${roleNames.join(", ")}`);
	}

	decomposing(): void {
		console.log(`${timestamp()} ${COLORS.magenta}🧠 Decomposing${COLORS.reset} task into subtasks via LLM...`);
	}

	plan(subtasks: Array<{ name: string; roleName: string; dependsOn: string[] }>): void {
		console.log("");
		console.log(`${timestamp()} ${COLORS.bold}📝 Plan${COLORS.reset} (${subtasks.length} subtasks):`);
		for (const s of subtasks) {
			const deps = s.dependsOn.length > 0 ? ` ${COLORS.gray}← depends on: ${s.dependsOn.join(", ")}${COLORS.reset}` : "";
			console.log(`         ${COLORS.yellow}${padRight(s.roleName, 15)}${COLORS.reset} ${s.name}${deps}`);
		}
		console.log("");
	}

	wave(waveNum: number, subtasks: Array<{ name: string; roleName: string }>): void {
		const names = subtasks.map((s) => `${s.roleName}:${s.name}`).join(", ");
		console.log(`${timestamp()} ${COLORS.bold}${COLORS.blue}▶ Wave ${waveNum}${COLORS.reset} spawning: ${names}`);
	}

	agentSpawn(agentId: string, roleName: string, mandate: string): void {
		console.log(`${timestamp()} ${COLORS.green}  + ${padRight(agentId, 18)}${COLORS.reset} ${mandate.slice(0, 80)}${mandate.length > 80 ? "..." : ""}`);
	}

	agentWorking(agentId: string): void {
		console.log(`${timestamp()} ${COLORS.yellow}  ⟳ ${agentId}${COLORS.reset} working...`);
	}

	agentDone(agentId: string, subtaskName: string): void {
		console.log(`${timestamp()} ${COLORS.green}  ✓ ${agentId}${COLORS.reset} completed: ${subtaskName} ${this.elapsed()}`);
	}

	agentFailed(agentId: string, error: string): void {
		console.log(`${timestamp()} ${COLORS.red}  ✗ ${agentId}${COLORS.reset} failed: ${error.slice(0, 100)}`);
	}

	agentRespawn(agentId: string, attempt: number): void {
		console.log(`${timestamp()} ${COLORS.yellow}  ↻ ${agentId}${COLORS.reset} respawning (attempt ${attempt})`);
	}

	merge(agentId: string, success: boolean, conflicts?: string[]): void {
		if (success) {
			console.log(`${timestamp()} ${COLORS.cyan}  ⎇ ${agentId}${COLORS.reset} merged into integration`);
		} else {
			console.log(`${timestamp()} ${COLORS.red}  ⎇ ${agentId}${COLORS.reset} merge CONFLICT: ${conflicts?.join(", ")}`);
		}
	}

	messageSent(from: string, to: string, type: string): void {
		console.log(`${timestamp()} ${COLORS.gray}  ✉ ${from} → ${to}${COLORS.reset} [${type}]`);
	}

	roomOpened(roomId: string, topic: string, members: string[]): void {
		console.log(`${timestamp()} ${COLORS.magenta}  ◉ Room${COLORS.reset} "${topic}" opened with ${members.join(", ")}`);
	}

	roomResolved(topic: string, decision: string): void {
		console.log(`${timestamp()} ${COLORS.magenta}  ◉ Room${COLORS.reset} "${topic}" resolved: ${decision.slice(0, 80)}`);
	}

	roomArbitrated(topic: string): void {
		console.log(`${timestamp()} ${COLORS.yellow}  ◉ Room${COLORS.reset} "${topic}" arbitrated by orchestrator (turn budget exhausted)`);
	}

	capabilityRequest(agentId: string, capability: string): void {
		console.log(`${timestamp()} ${COLORS.yellow}  ? ${agentId}${COLORS.reset} requested capability: ${capability}`);
	}

	capabilitySpawn(capability: string, agentId: string): void {
		console.log(`${timestamp()} ${COLORS.green}  + ${agentId}${COLORS.reset} spawned for capability: ${capability}`);
	}

	deadlockDetected(cycle: string[], killed: string): void {
		console.log(`${timestamp()} ${COLORS.red}  ⚠ Deadlock${COLORS.reset} detected: ${cycle.join(" → ")}. Killed: ${killed}`);
	}

	gate(passed: boolean, failedCommand?: string): void {
		if (passed) {
			console.log(`${timestamp()} ${COLORS.bold}${COLORS.green}🚪 Gate PASSED${COLORS.reset} ${this.elapsed()}`);
		} else {
			console.log(`${timestamp()} ${COLORS.bold}${COLORS.red}🚪 Gate FAILED${COLORS.reset}: ${failedCommand}`);
		}
	}

	repairRound(round: number): void {
		console.log(`${timestamp()} ${COLORS.yellow}🔧 Repair round ${round}${COLORS.reset} — re-running subtasks...`);
	}

	missionComplete(status: string, agentCount: number, wallTimeMs: number): void {
		console.log("");
		const statusColor = status === "succeeded" ? COLORS.green : COLORS.red;
		console.log(`${COLORS.bold}${statusColor}━━━ MISSION ${status.toUpperCase()} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
		console.log(`${COLORS.gray}Agents:${COLORS.reset} ${agentCount}`);
		console.log(`${COLORS.gray}Time:${COLORS.reset}   ${(wallTimeMs / 1000).toFixed(1)}s`);
		console.log(`${statusColor}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
		console.log("");
	}

	wallTimeExceeded(): void {
		console.log(`${timestamp()} ${COLORS.red}⏱ Wall time exceeded${COLORS.reset} — aborting mission`);
	}

	dependencyDeadlock(stuck: string[]): void {
		console.log(`${timestamp()} ${COLORS.red}⚠ Dependency deadlock${COLORS.reset} — these subtasks can't run: ${stuck.join(", ")}`);
	}

	planRejected(): void {
		console.log(`${timestamp()} ${COLORS.yellow}Plan rejected by user${COLORS.reset} — mission aborted`);
	}
}
