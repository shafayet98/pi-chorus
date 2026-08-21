import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const traceSrcIndex = fileURLToPath(new URL("../trace/src/index.ts", import.meta.url));
const coordSrcIndex = fileURLToPath(new URL("../coordination/src/index.ts", import.meta.url));
const worktreeSrcIndex = fileURLToPath(new URL("../worktree/src/index.ts", import.meta.url));
const orchestratorSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		resolve: {
			alias: [
				{ find: /^@pi-chorus\/trace$/, replacement: traceSrcIndex },
				{ find: /^@pi-chorus\/coordination$/, replacement: coordSrcIndex },
				{ find: /^@pi-chorus\/worktree$/, replacement: worktreeSrcIndex },
				{ find: /^@pi-chorus\/orchestrator$/, replacement: orchestratorSrcIndex },
			],
		},
		test: {
			include: ["test/**/*.test.ts"],
			testTimeout: 30000,
		},
	}),
);
