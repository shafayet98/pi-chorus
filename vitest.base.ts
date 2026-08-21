import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@pi-chorus\/telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@pi-chorus\/telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@pi-chorus\/ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@pi-chorus\/ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@pi-chorus\/ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@pi-chorus\/ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@pi-chorus\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@pi-chorus\/tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
