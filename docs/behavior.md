# Behavior comparison and evidence scope

This guide records the native-loading gaps that [agents-chain](../README.md) addresses. Native Codex findings were probed with 0.163.0 and Claude Code findings with 2.1.304 on macOS on 2026-10-20; their hook delivery was also checked with 0.164.0 and 2.1.309. Documentation was consulted on 2026-10-26. OpenCode 1.18.19 was inspected and probed without model requests on that date. These evidence types are deliberately separate.

## Native behavior differs

These are version-scoped findings, not promises about every future release. **P** means a controlled model-canary probe; **B** means a provider-free installed-binary probe; **S** means tagged source inspection or isolated service execution; **D** means documentation. The version headers identify the native probes; documentation claims have the consultation date above. The sections below explain the scope and link to sources.

| Behavior | Codex CLI 0.163.0 | Claude Code 2.1.304 | OpenCode V1 1.18.19 |
| --- | --- | --- | --- |
| Global entry point | `~/.codex/AGENTS.md`, with override precedence [D] | `~/.claude/CLAUDE.md`; supports `@` imports [P/D] | Config-directory `AGENTS.md`, then Claude global fallback [S] |
| Ancestors above a nested Git root | Not in the default project chain [P] | Can load ancestors; `CLAUDE.md` affects default AGENTS selection [P] | Startup stops at the worktree root [S] |
| Multiple startup files | Project root toward starting directory [P] | Ancestor chain; both-file mode loads CLAUDE and AGENTS [P/D] | Selected filename, starting directory toward root [S] |
| Later ordinary file reads | No AGENTS discovery in measured shell probes [P] | Nearby AGENTS through Read within the starting tree [P] | Nearby instructions through file `read`, nearest first [B/S] |
| Shell `cat` loads nearby AGENTS | Not in measured probes [P] | Not in measured probes [P] | Not in measured probes [B] |
| Outside the starting tree | No on-demand load in measured probes [P] | No nearby AGENTS in measured probes [P] | Normally excluded; a shared-prefix sibling edge case exists [B] |
| Size handling | Default combined project-doc budget is 32 KiB [P/D] | Added hook context has a separate runtime limit [D] | Large nearby instruction retained in debug-tool result; model delivery unverified [B] |
| Hooks supplied | Yes | Yes | Assessment and probes only |

OpenCode V2 has a different documented contract. Its behavior is kept separate in [the OpenCode assessment](opencode.md#v2-is-a-separate-contract).

## Codex

Controlled canaries showed root-to-start discovery within the nearest project root, no ancestor delivery above nested repositories or worktrees, and no later discovery through the measured shell reads. A custom root marker changed the boundary but also excluded instructions in repositories outside the marked tree. The measured combined project budget truncated deeper guidance after earlier ancestors. The global file was outside that project budget. PreToolUse blocking and subsequent retry worked in controlled sessions. These observations do not establish every tool, setting or release's behavior.

The [official AGENTS guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md) describes global and directory-level override/fallback selection. That broader native filename selection is not implemented by this AGENTS-only extension. [The hook guide](https://learn.chatgpt.com/docs/hooks) separately documents trust and output spilling. The package's native-state model assumes the default root markers, filename behavior and project budget; re-probe custom setups.

## Claude Code

Canaries showed ancestor discovery beyond nested Git roots, with default CLAUDE-file selection suppressing AGENTS. Both-file mode loaded both kinds and avoided duplicate imports/symlinks. Nearby AGENTS appeared on file Read beneath the starting tree, but not in the measured Bash reads or outside-tree reads. Hook context and first-write feedback reached the model in controlled sessions. An instruction can be supplied without being obeyed; file presence and model recollection alone are weaker evidence than a preserved tool trace.

The [memory documentation](https://code.claude.com/docs/en/memory) defines the plugin setting and import behavior. The supplied example explicitly selects `claude-md-and-agents-md`; it is a precondition of this adapter's native seeding. No fixed maximum for native instruction text was established by the earlier canaries. [Hook output handling](https://code.claude.com/docs/en/hooks) is a separate transport constraint and must not be generalized into a native-file limit.

## OpenCode

The [versioned assessment](opencode.md) separates installed-binary tool output, isolated tagged-source behavior, source inspection, documentation and unverified model behavior. V1 selects a project filename category across the startup chain and assembles it leaf-to-root. File reads provide nearby loading, while several other tools do not. Its plugin interfaces are different from the command-hook protocol used here. No OpenCode adapter is shipped, and no V2 runtime or provider compaction was tested.

## Rechecking

Use [the generic probes](probes.md) after runtime upgrades or configuration changes. Keep the version, fixture, exact prompt, tool arguments and trace. Use fresh sessions for each baseline and live case, prevent direct instruction-file reads when measuring automatic delivery, and keep expected codes out of prompts. A negative model answer needs repetition before concluding content was absent. Distinguish observed text returned by a tool from text delivered to a model and from actual instruction following.
