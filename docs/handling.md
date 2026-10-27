# Handling and limits

Use [the installation guide](../INSTALL.md) for setup by an agent or by hand. This page explains behavior and limits after registration.

## Supported native-loading setup

The adapters support Codex and Claude Code's command-hook JSON protocol. They have been exercised with Codex CLI 0.164.0 and Claude Code 2.1.309; earlier native-loading canary probes used 0.163.0 and 2.1.304. The library models Codex's default `.git` project root and 32768-byte project-doc budget, and Claude's `claude-md-and-agents-md` instruction setting. Custom root markers, fallback names, project-doc budgets, managed restrictions and future runtime changes need separate verification. The hook delivers `AGENTS.md`; it does not implement `AGENTS.override.md` precedence or expand arbitrary instruction imports.

Claude users must enable its AGENTS plugin and the both-file setting included in the example. Otherwise its native-loaded-file assumptions may be wrong. See [Claude's instruction documentation](https://code.claude.com/docs/en/memory). Codex global and project discovery are described in [its AGENTS guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

Keep the checkout at a stable path and merge the example hook entries with existing settings. Do not replace an entire user settings file. Register one live copy of each adapter per event. Hook sources can merge, so a session override does not remove a global registration. Changed Codex hook definitions require review and trust through `/hooks`. These hooks are synchronous; a background hook cannot enforce the first-write boundary.

## Global guidance and duplicate avoidance

Runtime global instructions still load normally. A shared home-level `AGENTS.md` can reach Codex through a symlink at its global entry point and Claude through a direct import in its global `CLAUDE.md`. That is native loading, not an instruction exclusion. The hook recognizes the active Codex global file by identity, and Claude's global file or a direct leading `@~/AGENTS.md`/relative/absolute import outside fenced code and code spans. It avoids reinjecting the same inode when that native relationship is established. Unknown import forms and missing global entry points do not cause a separate home-level file to be dropped merely because it is named `AGENTS.md`. This detection is conservative and does not reproduce the runtime's full import parser. Native loading and instruction following should still be checked with the supplied probes.

## Start with observation, then enable

Both example configurations pass `--log-only`. This computes and logs decisions without injecting text or denying tools, using a separate state namespace. A logged `bounce` in this mode is a projection, not a blocked write. Remove that flag from both SessionStart and PreToolUse commands only after reviewing a fresh-session before/after probe. `AGENTS_CHAIN_MODE=log` also selects observation, while `AGENTS_CHAIN_DISABLE=1` turns off this hook entirely. The flag takes precedence over the mode variable.

Start fresh sessions for comparisons. Record the activation time and inspect `agents-chain-report --since TIME`. Confirm live records exist, identical write retries complete, the intended file chain appears, and no internal errors are recorded. Repeated seconds-long delays, lock/deadline failures, unexpectedly frequent resets or resends, and repeated identical blocks deserve investigation. To roll back, restore `--log-only` and start fresh sessions; this keeps observational telemetry.

## Supported tools

The supplied `PreToolUse` matchers register these tool names:

| Runtime | File tools | Shell tools |
| --- | --- | --- |
| Codex | `apply_patch` | `Bash`, `exec_command` |
| Claude Code | `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | `Bash` |

Both adapters also register `SessionStart`. See the exact [Codex](../examples/codex.toml) and [Claude Code](../examples/claude.json) configurations. Tools outside these matchers are not covered by the supplied registrations; a tool that accesses files is not automatically supported. Shell classification uses visible commands and path arguments, not the filesystem operations performed inside a script.

## Delivery and worktrees

SessionStart seeds the files the configured runtime is expected to load natively and supplies missing ancestors. PreToolUse classifies supported file tools, patches and shell calls.

Reads receive missing context. A write that encounters undelivered instructions gets exit code 2 and the rendered chain on stderr; the agent must retry the identical tool invocation. The hook does not execute the tool or retry it on the agent's behalf. The retry passes once pending instructions fit. A read or SessionStart may already have delivered the rules, so the first write does not always block.

Shell calls can access paths in several directories. Their combined instructions use a heading about the accessed paths, and each file block or reference identifies the directory it governs. `git worktree list`, `git stash list`, and `git stash show` are repository reads; mutating forms retain write classification. A file destination supplied with `--output`, a file output redirect, or another mutating command in the same shell call still makes that call a write.

For two seconds after delivery, a different parallel write under the same rules can also block. Changed files are resent as context. Codex has a four-hour fallback for unchanged deliveries because retained context can be uncertain.

Shell parsing is best effort: paths inside scripts, dynamic substitutions, unusual shell syntax, missing workdir data and unsupported tools can defeat attribution. An unresolved-word counter measures parser uncertainty rather than a true path-miss rate. The hook is not a universal filesystem interposer. Git is used to recover a linked worktree's main checkout; containing instructions above that checkout are added to the worktree's physical chain. No Git synchronization, branch mutation or publication is performed.

Files are identified by device and inode. A never-seen file matching previously delivered or native content receives a short reference rather than another full copy. Outlines do not establish a full-content twin. Content updates, earlier resets and fallback resends remain distinct reasons. Direct Claude Read/Write operations on AGENTS files have their own state handling; shell mentions go through ordinary chain delivery.

## Size and ordering

The full-text budget is 64 KiB between reset events, per runtime/session/subagent/mode. It counts final UTF-8 output, including wrappers and references. `resume` preserves the epoch; other SessionStart sources reset it. A reset is an accounting boundary, not proof that earlier instructions left model context. Native instructions and direct file reads are outside this budget.

Files that do not fit become factual outlines with path, source size and level-one/two headings. Headings inside fences are ignored, and outlines are bounded to 24 lines and 1536 heading bytes. Outlines remain available beyond the full-text budget and count toward total emitted bytes. They do not replace reading applicable rules. Runtime character budgets remain 9500 for Claude added context, 32000 for Codex added context and 40000 for write feedback. Files that cannot fit even as metadata stay pending; an unusually deep chain can require more than one bounded retry.

The runtime may additionally shorten or spill hook output to a saved file. Codex documents a default approximate threshold of 2500 tokens and `additionalContextLimit` for added context; feedback has its own limit. See [Codex hook output handling](https://learn.chatgpt.com/docs/hooks). Do not equate an emitted-byte counter with confirmed model receipt or resident context. Follow saved-output references when needed, and verify the actual transcript and model response.

## Trust, state and privacy

Only user-owned regular AGENTS files under home are considered. Symlinked instruction names pointing at another filename, invalid UTF-8, empty files, dependency and Git internals, and excluded directory trees are skipped. Defaults exclude Downloads, Trash and common credential directories `.ssh`, `.gnupg` and `.aws`. Extend those roots with an environment variable containing a JSON array of absolute paths:

```bash
export AGENTS_CHAIN_EXCLUDED_ROOTS='["/absolute/path/to/sensitive-directory"]'
```

Configure it in the environment that launches the runtime or directly in hook commands. Exclusions are canonicalized for instruction discovery and apply to explicit usage reads as well. Do not broaden trust to unreviewed checkouts. Invalid exclusion configuration fails open for hooks; fix its recorded diagnostic before assuming coverage.

Owner-only state lives under `${XDG_STATE_HOME:-$HOME/.local/state}/agents-chain/`. The hook requires POSIX ownership/permission semantics; Windows is not verified. State uses private regular JSON files, atomic replacement and bounded locks. Sessions untouched for 14 days are pruned. Logs rotate at 20 MiB with one previous generation. They include instruction paths, digested session identifiers, reasons, bytes, numeric token partitions, errors and timings, not instruction or shell-command text. Paths themselves can be sensitive; do not publish raw logs. Collector failure records `instrumentError` without changing output or denial behavior. Other internal errors also fail open, so a successful tool call does not prove instruction coverage.

## Reporting and token estimates

```bash
node agents-chain-report
node agents-chain-report --json --since 2026-10-26T00:00:00Z
node agents-chain-report --usage-file /path/to/selected-session.jsonl
```

Reports separate runtime and mode, show partial/uncertain reset coverage, retries, limits, timing and errors, and estimate emitted or projected tokens with the labeled `utf8-bytes/4` heuristic. Fractional estimates make byte attribution additive. Full blocks, outlines, notes, covered references and wrappers have separate volume; reasons and largest contributing paths help diagnose resends. Legacy byte-only records retain unknown attribution.

Optional usage sources are explicit local files, read only by the report command. Codex cumulative snapshots are selected rather than summed. Claude request updates are deduplicated, with input normalized to include cache reads and writes. Missing counters, baselines or timestamps, counter resets, invalid identifiers and partial sources remain explicit. Regular files are limited to 64 MiB of observed extent; lines over 1 MiB are skipped. The transcript schema is version-sensitive. Session totals are not the counterfactual extra cost of the hook, reasoning is not added twice to output, and no dollar-increase percentage is inferred. Collection makes no provider calls and writes no transcripts.
