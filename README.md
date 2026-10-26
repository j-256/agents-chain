# agents-chain

Give coding agents the `AGENTS.md` rules that govern the files they work on.

These hooks supply missing instructions to **Codex and Claude Code** across nested Git repositories, later file access and linked worktrees. Reads receive context; writes that need undelivered instructions pause so the agent can read them before retrying.

The hooks make no model or API calls and have no runtime package dependencies. The example configurations start in **log-only mode**, so you can inspect decisions before enabling delivery.

## Why use it?

Instruction files often form a chain:

```text
~/workspace/
├── AGENTS.md
└── app/
    ├── .git/
    ├── AGENTS.md
    └── src/
        ├── AGENTS.md
        └── feature.ts
```

An agent launched inside `app/` can miss the workspace rules if native discovery stops at that Git root. A later shell read of `src/feature.ts` can also miss the source-directory rules. Which layers load depends on the runtime, its settings and the tool used; see the [versioned native-behavior comparison](docs/behavior.md).

The hooks collect each supported target's governing chain, including ancestors of a linked worktree's main checkout. Your normal global instructions still load through the runtime as usual, and the hooks avoid sending recognized shared files again.

## Get started

Requires **Node.js 22+, npm and Git** on macOS or Linux. Keep the installation at a stable path because the runtime invokes those files directly.

Give your coding agent this repository and ask:

> Read INSTALL.md in this repository and install the hooks for Codex and Claude Code in log-only mode. Preserve my existing settings and instruction files, avoid duplicate hook registrations, and verify the setup. Tell me any runtime review step I need to complete.

Name just one runtime if you only use one. [INSTALL.md](INSTALL.md) also provides manual setup, verification, updates and removal.

Log-only mode records decisions without injecting instructions or blocking writes. Use the [isolated before/after probes](docs/probes.md) to verify delivery and retries before enabling live mode.

## How delivery works

| When | Live behavior |
| --- | --- |
| Session starts | Account for instructions the runtime is expected to load natively, then supply missing ancestors |
| A supported tool reads a path | Add missing governing instructions as hook context before the tool runs |
| A supported tool writes under undelivered rules | Block the call, return the instructions and ask the agent to retry the identical invocation |
| Instructions have already been delivered | Avoid repeated full text; detect content changes and resend when needed |

A read can supply the rules before the first write, so that write may proceed without a block. Large chains and concurrent writes can need additional retries. See [supported tools and delivery details](docs/handling.md#supported-tools).

Full-text delivery has a **64 KiB budget between reset events**. Overflow becomes bounded outlines with paths, sizes and headings; the agent must read the file for its full rules. Native instructions and direct reads are outside this budget. See [size and ordering](docs/handling.md#size-and-ordering).

## Inspect delivery

Run from the installation directory, using the same `XDG_STATE_HOME` as the hooks if you set one:

```bash
node agents-chain-report
node agents-chain-report --json
```

Reports separate runtime and mode, with delivery reasons, retries, volume, timing and errors. A log-only `bounce` is a projected block. [Reporting and token estimates](docs/handling.md#reporting-and-token-estimates) covers time filters, optional local transcript usage and the distinction between emitted text, model receipt and billing.

## Compatibility and limits

- **Version scope:** hook delivery was checked with Codex CLI 0.164.0 and Claude Code 2.1.309. Follow the [native-loading assumptions](docs/handling.md#supported-native-loading-setup), including Claude's required instruction setting, and recheck after runtime or configuration changes.
- **File scope:** only user-owned regular `AGENTS.md` files under home are eligible, with configurable directory exclusions. Shell path detection is best effort; arbitrary instruction imports are not expanded.
- **Failure behavior:** internal errors let the tool call proceed. Supplied instructions are context, not a security boundary or a guarantee that the agent follows them.
- **Local state:** private state and logs live under `${XDG_STATE_HOME:-$HOME/.local/state}/agents-chain/`. Logs omit instruction and command text but include paths. See [trust, state and privacy](docs/handling.md#trust-state-and-privacy).

OpenCode has a separate [V1 assessment and V2 documentation comparison](docs/opencode.md). No OpenCode adapter is shipped.

## Documentation

| Guide | Use it to |
| --- | --- |
| [Installation](INSTALL.md) | Set up, verify, update or remove the hooks |
| [Handling and limits](docs/handling.md) | Understand tool coverage, retries, budgets, state and reporting |
| [Before/after probes](docs/probes.md) | Check model-visible instructions and first-write retries in isolated sessions |
| [Native behavior comparison](docs/behavior.md) | Compare version-scoped findings for Codex, Claude Code and OpenCode |
| [OpenCode probes](docs/opencode-probes.md) | Reproduce the provider-free V1 research |

## Development

From a source checkout:

```bash
npm ci
npm run check
```

Checks cover syntax, portable paths, hook behavior, reporting and archive installation. Extracted archives have [separate checks](INSTALL.md#1-keep-the-files-at-a-stable-path) because they omit development scripts and tests.

License: [AGPL-3.0-only](LICENSE). OpenCode-derived research helpers retain their [upstream notices](THIRD_PARTY_NOTICES.md).
