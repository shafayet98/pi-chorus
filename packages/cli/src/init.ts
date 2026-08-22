import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { BUILTIN_ROLES, ROLE_CATEGORIES, type BuiltinRole } from "./builtin-roles/roles.ts";

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	blue: "\x1b[34m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
	magenta: "\x1b[35m",
};

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(question, (answer) => resolve(answer.trim()));
	});
}

function print(msg: string): void {
	console.log(msg);
}

/**
 * Interactive project initialization.
 *
 * Guides the user through setting up a new pi-chorus project:
 * 1. Git initialization (if needed)
 * 2. Integration branch creation
 * 3. Role selection (built-in or custom)
 * 4. Role catalog creation
 */
export async function runInit(): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const cwd = process.cwd();

	print("");
	print(`${C.bold}${C.blue}  pi-chorus init${C.reset}`);
	print(`${C.gray}  Set up a new project for multi-agent development${C.reset}`);
	print("");

	// Step 1: Check git
	const hasGit = existsSync(join(cwd, ".git"));
	if (!hasGit) {
		const initGit = await ask(rl, `${C.yellow}?${C.reset} No git repo found. Initialize one? ${C.dim}(Y/n)${C.reset} `);
		if (initGit === "" || initGit.toLowerCase() === "y" || initGit.toLowerCase() === "yes") {
			execSync("git init", { cwd, stdio: "pipe" });

			// Create initial commit if no commits exist
			if (!existsSync(join(cwd, "README.md"))) {
				const projectName = cwd.split("/").pop() ?? "my-project";
				writeFileSync(join(cwd, "README.md"), `# ${projectName}\n`);
			}
			if (!existsSync(join(cwd, "package.json"))) {
				writeFileSync(join(cwd, "package.json"), `{\n  "name": "${cwd.split("/").pop()}",\n  "type": "module"\n}\n`);
			}
			execSync("git add . && git commit -m 'init'", { cwd, stdio: "pipe" });
			print(`  ${C.green}+${C.reset} Git initialized with initial commit`);
		} else {
			print(`  ${C.yellow}!${C.reset} Git is required. Run ${C.cyan}git init${C.reset} first.`);
			rl.close();
			return;
		}
	} else {
		print(`  ${C.green}✓${C.reset} Git repo found`);
	}

	// Step 2: Check integration branch
	try {
		execSync("git rev-parse --verify integration", { cwd, stdio: "pipe" });
		print(`  ${C.green}✓${C.reset} Integration branch exists`);
	} catch {
		const createBranch = await ask(rl, `${C.yellow}?${C.reset} Create integration branch? ${C.dim}(Y/n)${C.reset} `);
		if (createBranch === "" || createBranch.toLowerCase() === "y") {
			const currentBranch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
			execSync("git checkout -b integration", { cwd, stdio: "pipe" });
			execSync(`git checkout ${currentBranch}`, { cwd, stdio: "pipe" });
			print(`  ${C.green}+${C.reset} Integration branch created`);
		}
	}

	// Step 3: Role selection
	print("");
	print(`${C.bold}  Select agent roles${C.reset}`);
	print(`${C.gray}  These define what kinds of agents can work on your project${C.reset}`);
	print("");

	const roleChoice = await ask(rl, `${C.yellow}?${C.reset} How would you like to set up roles?\n    ${C.cyan}1${C.reset}) Use all built-in roles (recommended)\n    ${C.cyan}2${C.reset}) Pick specific roles\n    ${C.cyan}3${C.reset}) Start with no roles (I'll create my own)\n  ${C.dim}Choice (1/2/3):${C.reset} `);

	let selectedRoles: BuiltinRole[] = [];

	if (roleChoice === "1" || roleChoice === "") {
		selectedRoles = [...BUILTIN_ROLES];
	} else if (roleChoice === "2") {
		print("");
		for (const [catKey, catInfo] of Object.entries(ROLE_CATEGORIES)) {
			print(`  ${C.bold}${catInfo.label}${C.reset} ${C.dim}— ${catInfo.description}${C.reset}`);
			const catRoles = BUILTIN_ROLES.filter((r) => r.category === catKey);
			for (const role of catRoles) {
				const answer = await ask(rl, `    ${C.yellow}?${C.reset} ${C.cyan}${role.name}${C.reset} — ${role.description} ${C.dim}(Y/n)${C.reset} `);
				if (answer === "" || answer.toLowerCase() === "y") {
					selectedRoles.push(role);
				}
			}
			print("");
		}
	} else {
		print(`\n  ${C.dim}No roles selected. Create YAML files in ./roles/ when ready.${C.reset}`);
	}

	// Step 4: Create roles directory and files
	if (selectedRoles.length > 0) {
		const rolesDir = join(cwd, "roles");
		if (!existsSync(rolesDir)) {
			mkdirSync(rolesDir, { recursive: true });
		}

		for (const role of selectedRoles) {
			const filePath = join(rolesDir, role.filename);
			if (existsSync(filePath)) {
				print(`  ${C.dim}~${C.reset} ${role.filename} already exists, skipping`);
			} else {
				writeFileSync(filePath, role.content);
				print(`  ${C.green}+${C.reset} roles/${role.filename}`);
			}
		}
	}

	// Step 5: Check API key
	print("");
	if (process.env.ANTHROPIC_API_KEY) {
		print(`  ${C.green}✓${C.reset} ANTHROPIC_API_KEY is set`);
	} else if (process.env.OPENAI_API_KEY) {
		print(`  ${C.green}✓${C.reset} OPENAI_API_KEY is set`);
	} else {
		print(`  ${C.yellow}!${C.reset} No API key found. Set one before running a mission:`);
		print(`    ${C.cyan}export ANTHROPIC_API_KEY="sk-ant-..."${C.reset}`);
	}

	// Done
	print("");
	print(`${C.bold}${C.green}  Ready!${C.reset} Run your first mission:`);
	print("");
	print(`    ${C.cyan}pi-chorus run "describe what you want to build" --gate "npm test" --auto${C.reset}`);
	print("");
	if (selectedRoles.length > 0) {
		print(`  ${C.dim}${selectedRoles.length} roles configured: ${selectedRoles.map((r) => r.name).join(", ")}${C.reset}`);
		print(`  ${C.dim}Edit files in ./roles/ to customize agent behavior.${C.reset}`);
	}
	print("");

	rl.close();
}
