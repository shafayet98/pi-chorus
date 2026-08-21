import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const traceSrcIndex = fileURLToPath(new URL("../trace/src/index.ts", import.meta.url));
const viewerSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		resolve: {
			alias: [
				{ find: /^@pi-chorus\/trace$/, replacement: traceSrcIndex },
				{ find: /^@pi-chorus\/viewer$/, replacement: viewerSrcIndex },
			],
		},
		test: {
			include: ["test/**/*.test.ts"],
			testTimeout: 10000,
		},
	}),
);
