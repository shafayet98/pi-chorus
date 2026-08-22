# pi-chorus

A self-organizing multi-agent coding system. You give it a task, not a headcount. It decomposes the work, spawns agents from a role catalog you define, and they coordinate through rooms and messages to build your project — each in an isolated git worktree, merging into an integration branch when done.

```
pi-chorus run "Build a REST API with auth and a React frontend" --gate "npm test" --auto
```

## How it works

1. You describe what you want built
2. An LLM decomposes it into subtasks and assigns roles from your catalog
3. Agents spawn in dependency waves — planner first, then backend + frontend in parallel, then QA
4. Each agent works in its own git worktree with exclusive file claims
5. Agents coordinate via direct messages and negotiation rooms
6. Completed work merges into an integration branch
7. A verification gate (your test suite) validates the result
8. You watch everything live in the browser at `localhost:3000`

## Install

```bash
npm install -g @pi-chorus/cli
```

That's it. Requires Node 22+.

Or use without installing:

```bash
npx @pi-chorus/cli run "Build a todo app" --gate "npm test" --auto
```

### From source (for development)

```bash
git clone https://github.com/shafayet98/pi-chorus.git
cd pi-chorus
npm install --legacy-peer-deps
npm run build
npm link -w packages/cli
```

## Set up your API key

pi-chorus uses LLMs to decompose tasks and run agents. Set your provider key:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Add it to `~/.zshrc` or `~/.bashrc` to persist across sessions.

## Quick start

### 1. Initialize your project

pi-chorus works on a **separate project** — the repo you want agents to build or modify.

```bash
mkdir my-project && cd my-project
git init
echo '# My Project' > README.md
git add . && git commit -m "init"
git checkout -b integration    # agents merge work here
git checkout main
```

### 2. Create a role catalog

Create a `roles/` directory with YAML files. Each file defines one kind of agent.

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
  Always claim files before writing. Call signal_done() when finished.
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - src/api/**
  - src/routes/**
  - package.json
```

**roles/frontend.yaml**
```yaml
name: frontend
description: "Frontend development"
capabilities: [frontend, ui, html, css]
system_prompt: |
  You are a frontend developer. Write clean, accessible HTML/CSS/JS.
  Always claim files before writing. Call signal_done() when finished.
model: sonnet
tools: [read, write, edit, bash]
path_scope:
  - public/**
  - src/views/**
  - src/components/**
```

Create as many roles as you need. The decomposer will assign subtasks to them.

### 3. Run a mission

```bash
cd my-project

pi-chorus run "Build a todo app with user auth and a REST API" \
  --gate "npm test" \
  --auto
```

Open `http://localhost:3000` in your browser to watch the live dashboard.

## CLI reference

```
pi-chorus run <description>     Run a mission
pi-chorus view [--port 3000]    Launch the trace viewer
pi-chorus replay <mission-id>   Dump a trace to stdout
pi-chorus list                  List past missions
```

**Options for `run`:**

| Flag | Description | Default |
|------|-------------|---------|
| `--gate <cmd>` | Verification command (e.g., `npm test && npm run build`) | `echo 'ok'` |
| `--repo <path>` | Repository path | `.` (current directory) |
| `--catalog <path>` | Role catalog directory | `./roles` |
| `--max-agents <n>` | Maximum concurrent agents | `10` |
| `--auto` | Skip interactive approvals | off (prompts for plan approval) |
| `--port <n>` | Port for live viewer | `3000` |

## Role catalog format

Each role is a YAML file in your `roles/` directory:

```yaml
name: backend              # unique identifier
description: "..."         # what this role does (shown to the LLM decomposer)
capabilities: [api, rest]  # tags for capability matching
system_prompt: |           # the agent's system prompt
  You are a backend developer...
model: sonnet              # LLM model: sonnet, opus, haiku
tools: [read, write, edit, bash]  # which tools to enable
path_scope:                # files this role can claim (glob patterns)
  - src/api/**
  - package.json
local_gate: "npm test"     # optional: runs before signaling done
```

**Path scope** controls what files an agent can write to. A frontend agent can't claim `migrations/`. This is what makes file leases safe.

**Model** maps to: `sonnet` = Claude Sonnet 4.6, `opus` = Claude Opus 4.6, `haiku` = Claude Haiku 4.5.

## What agents can do

Every agent gets these coordination tools:

| Tool | Description |
|------|-------------|
| `claim(paths)` | Claim files for exclusive write access |
| `release(paths)` | Release file claims |
| `send(to, type, content)` | DM another agent |
| `read_messages()` | Read inbox |
| `open_room(topic, question, invite)` | Open a negotiation room |
| `send_to_room(room_id, type, content)` | Send PROPOSE/ACCEPT/REJECT |
| `resolve_room(room_id, decision, rationale)` | Close room with a decision |
| `read_decision(decision_id)` | Read a decision record |
| `request_capability(tag, reason)` | Ask orchestrator for a specialist |
| `read_scratch(path)` / `write_scratch(path, content)` | Shared pre-merge data |
| `signal_done()` | Mark work complete |

Plus the standard coding tools: `read`, `write`, `edit`, `bash`, `glob`, `grep` (as enabled in the role).

## Live viewer

The live dashboard at `localhost:3000` shows:

- **Live Feed** — every event as it happens (tool calls, messages, merges)
- **Rooms** — negotiation rooms with proposals, accepts, and decisions
- **Messages** — direct messages between agents with full content
- **Swimlanes** — per-agent event timelines (click an agent in the sidebar to filter)
- **Roster** — agents that spawned, their roles, and mandates

The viewer auto-connects and persists data across page refreshes.

## How the orchestrator works

```
Mission description
        |
        v
  [Decomposer] ── LLM breaks task into subtasks with dependencies
        |
        v
  [Wave scheduler] ── runs subtasks in dependency order
        |
    Wave 1: planner (no dependencies)
    Wave 2: planReviewer (depends on planner)
    Wave 3: backend + frontend (parallel, depend on planReviewer)
    Wave 4: QA + security (depend on backend/frontend)
    Wave 5: codeReviewer (depends on everything)
        |
        v
  [Verification gate] ── runs your test command
        |
    Pass → mission succeeded
    Fail → repair loop (re-run subtasks, up to 3 rounds)
```

Each agent:
- Gets its own **git worktree** (isolated checkout)
- Must **claim files** before writing (lease system with path scope enforcement)
- Can **send messages** and **open rooms** to coordinate with other agents
- Signals **done** when finished, triggering merge into the integration branch

## Safety

Agents run shell commands. For autonomous runs, containerize:

```bash
docker run --rm --network none \
  -v $(pwd):/workspace -w /workspace \
  -e ANTHROPIC_API_KEY \
  node:22 pi-chorus run "..." --gate "npm test" --auto
```

See [SANDBOX.md](SANDBOX.md) for Docker and micro-VM patterns.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

```
┌─────────────────────────────────────────────────────┐
│                   CLI (pi-chorus)                     │
├─────────────────────────────────────────────────────┤
│                   ORCHESTRATOR                       │
│  task decomposition · wave scheduling · caps · rooms │
├──────────┬──────────┬──────────┬────────────────────┤
│ Agent #1 │ Agent #2 │ Agent #3 │  ...               │
├──────────┴──────────┴──────────┴────────────────────┤
│              COORDINATION LAYER                      │
│  message bus · lease manager · rooms · capabilities  │
├─────────────────────────────────────────────────────┤
│              WORKTREE MANAGER                        │
│  git worktrees · merge pipeline · verification gate  │
├─────────────────────────────────────────────────────┤
│              TRACE STORE + LIVE VIEWER               │
│  SQLite events · content-addressed blobs · SSE       │
├─────────────────────────────────────────────────────┤
│         PI FOUNDATIONS (forked)                       │
│   agent-core · pi-ai · pi-telemetry                  │
└─────────────────────────────────────────────────────┘
```

## License

MIT
