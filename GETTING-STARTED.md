# Getting Started with Pi-Chorus

A step-by-step guide to running your first pi-chorus mission.

## Prerequisites

```bash
# Node 22+ required
node --version  # should be >= 22.19.0

# Clone and set up pi-chorus
cd pi-chorus
npm install --legacy-peer-deps
npm run build
```

## 1. Set your LLM API key

Pi-chorus uses `@pi-chorus/ai` which supports Anthropic, OpenAI, Google, and 30+ other providers. Set whichever you want to use:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# or
export OPENAI_API_KEY="sk-..."
```

## 2. Create a target project

Pi-chorus works on a **separate repository** — the project you want agents to build or modify.

```bash
mkdir -p /tmp/my-project && cd /tmp/my-project
git init
git config user.email "you@example.com"
git config user.name "Your Name"

# Create initial structure
echo '# My Project' > README.md
echo '{}' > package.json
git add . && git commit -m "init"

# Create the integration branch (pi-chorus merges agent work into this)
git checkout -b integration
git checkout main
```

The `integration` branch is required. All agent work merges into it, and the verification gate runs against it.

## 3. Create a role catalog

In your target project, create a `roles/` directory with YAML files. Each file defines one kind of agent.

```bash
mkdir roles
```

**roles/backend.yaml**
```yaml
name: backend
description: "Node.js backend development"
capabilities: [backend, api, server]
system_prompt: |
  You are a backend developer. Write clean Node.js code.
  Claim files before writing. Signal done when finished.
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - src/**
  - package.json
```

**roles/frontend.yaml**
```yaml
name: frontend
description: "Frontend development"
capabilities: [frontend, ui, html, css]
system_prompt: |
  You are a frontend developer. Write clean HTML/CSS/JS.
  Claim files before writing. Signal done when finished.
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - public/**
  - index.html
```

**roles/testing.yaml**
```yaml
name: testing
description: "Test writing"
capabilities: [testing, tests, unit-tests]
system_prompt: |
  You are a test engineer. Write comprehensive tests.
  Claim files before writing. Signal done when finished.
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - test/**
  - "**/*.test.js"
```

### Role catalog fields

| Field | Description |
|-------|-------------|
| `name` | Unique role identifier |
| `description` | What this role does (shown to the decomposer LLM) |
| `capabilities` | Tags for matching `request_capability()` calls |
| `system_prompt` | The agent's system prompt |
| `model` | LLM model: `sonnet`, `opus`, `haiku`, `gpt-4o`, etc. |
| `tools` | Which tools to enable: `read`, `write`, `edit`, `bash`, `glob`, `grep` |
| `path_scope` | Glob patterns for files this role can claim (write access) |
| `local_gate` | Optional command to run before signaling done |

## 4. Run a mission

From the pi-chorus directory:

```bash
cd /path/to/pi-chorus
```

### Fully autonomous (no prompts)

```bash
npx tsx packages/cli/src/cli.ts run \
  "Create a simple Express server with a /health endpoint" \
  --repo /tmp/my-project \
  --catalog /tmp/my-project/roles \
  --gate "node src/index.js --help || true" \
  --auto
```

### Interactive (approves plan before spawning)

```bash
npx tsx packages/cli/src/cli.ts run \
  "Create a REST API with /users and /posts endpoints" \
  --repo /tmp/my-project \
  --catalog /tmp/my-project/roles \
  --gate "npm test" \
  --max-agents 3
```

In interactive mode, you'll be prompted to approve the decomposition plan before agents spawn.

### CLI options

| Option | Description | Default |
|--------|-------------|---------|
| `--gate <cmd>` | Verification command(s), joined with `&&` | `echo 'No gate configured'` |
| `--repo <path>` | Path to the target repository | `.` |
| `--catalog <path>` | Path to the role catalog directory | `./roles` |
| `--max-agents <n>` | Maximum number of agents to spawn | `10` |
| `--auto` | Skip interactive approvals (fully autonomous) | off |
| `--port <n>` | Port for the trace viewer | `3000` |

## 5. View the trace

After a mission runs, launch the web viewer to explore what happened:

```bash
npx tsx packages/cli/src/cli.ts view --port 3000
```

Open `http://localhost:3000` in your browser and enter the mission ID (printed after the run).

### Viewer tabs

- **Swimlanes** — per-agent event timelines, grouped by agent
- **Roster** — agents that appeared during the run, with their roles and mandates
- **All Events** — every trace event in Lamport clock order
- **Replay** — events with fully resolved payloads for debugging

Click any event to inspect its full payload.

## 6. Replay a trace

Dump all events for a mission to stdout in causal order:

```bash
npx tsx packages/cli/src/cli.ts replay <mission-id>
```

Each line is a JSON object with `clock`, `agent`, `kind`, `causes`, and `payload`.

## 7. List past missions

```bash
npx tsx packages/cli/src/cli.ts list
```

## What happens during a run

1. **Catalog loaded** — role definitions read from YAML files
2. **Task decomposed** — the LLM breaks your mission into subtasks, each assigned to a role
3. **Plan approved** — in interactive mode, you see the plan and approve it
4. **Agents spawned** — each subtask gets an agent with its own git worktree
5. **Agents work** — they claim files, write code, communicate via messages and rooms
6. **Agents merge** — completed work is merged into the integration branch
7. **Gate runs** — your verification command runs against the integration branch
8. **Repair loop** — if the gate fails, agents are re-run (up to `maxRepairRounds`)

## Coordination tools available to agents

Every agent automatically gets these tools:

| Tool | Description |
|------|-------------|
| `claim(paths)` | Claim files for exclusive write access |
| `release(paths)` | Release file claims |
| `send(to, type, content)` | DM another agent |
| `read_messages()` | Read inbox messages |
| `open_room(topic, question, invite)` | Open a negotiation room |
| `send_to_room(room_id, type, content)` | Send PROPOSE/ACCEPT/REJECT to a room |
| `resolve_room(room_id, decision, rationale)` | Close a room with a decision |
| `read_decision(decision_id)` | Read a decision record |
| `request_capability(capability, reason)` | Ask for a specialist agent |
| `read_scratch(path)` | Read shared data from scratch space |
| `write_scratch(path, content)` | Write shared data to scratch space |
| `signal_done()` | Signal work is complete |

## Safety and sandboxing

Agents execute shell commands and write files. For autonomous runs, see [SANDBOX.md](SANDBOX.md) for Docker and micro-VM containerization patterns.

## Known limitations

- **Trace store is in-memory** — missions don't persist between CLI invocations. The `list` command will show nothing until a real SQLite backend is added.
- **No live WebSocket streaming yet** — the viewer polls the API. Live updates during a run are planned.
- **Token tracking is approximate** — total token counts are tracked but not yet enforced as a hard cap.
