# OpenCode V1 instruction-loading assessment

Verified 2026-10-26 with installed OpenCode **1.18.19** on macOS arm64 and official source tag [v1.18.19](https://github.com/anomalyco/opencode/tree/v1.18.19). This assessment describes V1. The installed binary reported that version; matching the version to a source tag does not establish reproducible-build identity.

Evidence labels: **B** = installed binary, provider-free debug-tool probe; **S** = exact tagged instruction service executed with mocked platform services and local fixture files; **C** = tagged source inspection; **D** = official documentation; **U** = unverified. B proves tool results, S proves service behavior under its stated adapters, and neither proves a model followed the instructions. The [probe recipe](opencode-probes.md) explains reproduction; generated results remain private to each run.

## Table-ready summary

| Behavior | OpenCode 1.18.19 V1 | Evidence |
| --- | --- | --- |
| Global file | `${XDG_CONFIG_HOME:-~/.config}/opencode/AGENTS.md`; the instruction service uses `OPENCODE_CONFIG_DIR/AGENTS.md` when that override is set | C, S |
| Global Claude fallback | `~/.claude/CLAUDE.md` only when the global OpenCode file does not exist | C, S |
| Project filename priority | Search the entire startup chain for `AGENTS.md`; only if none exists, search for `CLAUDE.md`; otherwise deprecated `CONTEXT.md` | C, S |
| Multiple project files | All files matching the selected filename load from the starting directory through the Git worktree root, inclusive | C, S |
| Startup order | Global first, then project files **leaf-to-root**, then configured local files, then configured URLs | C, S |
| Nested Git repositories | Startup stops at the nearest repository/worktree root; a later read beneath the starting directory can cross a nested repository boundary | C; B for dynamic traversal |
| No Git repository | Startup traversal can reach the filesystem root | C |
| Nearby loading on file read | The `read` tool adds nearby files nearest-first, excluding the session's starting directory and files already in startup/configured paths | B, S, C |
| Directory listing, shell, search, writes | A directory passed to `read`, shell `cat`, `glob`, and `write` do not attach nearby instructions; no loader call in `grep`, `edit`, or `apply_patch` | B for listed probes; C for other tools |
| Outside the starting tree | Normally excluded, even inside another area of the same worktree; **a sibling whose path merely shares the starting-directory string prefix can load instructions** | B, S, C |
| Linked worktrees | Startup uses that linked worktree's root; it does not recover the main checkout's containing directories | C |
| Changes and dedupe | Startup/configured file contents are read again for each ordinary model-loop request; nearby files already recorded in retained read metadata are not refreshed when edited | S, C |
| Compaction | Pruned read records and records removed from model-visible history no longer prevent nearby rediscovery; an actual provider compaction cycle was not exercised | S, C; U for end-to-end cycle |
| Instruction size cap | No instruction-specific cap found; a nearby instruction exceeding 100 KB reached the binary read result with its end marker and `truncated: false` | B, S, C |
| Extensions | JavaScript/TypeScript plugins expose tool-before/tool-after, experimental system/messages transforms, compaction customization, and session events | C, D; U for a live adapter |

## Scope and precedence details

The [instruction loader](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/session/instruction.ts) chooses the global file independently from the project filename category. An ancestor `AGENTS.md` suppresses a closer `CLAUDE.md` at startup, while multiple `AGENTS.md` files all load. Dynamic discovery instead chooses `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md` separately in each directory, so one read can attach a child's `CLAUDE.md` and a parent's `AGENTS.md`. Automatic project `.claude/CLAUDE.md`, `CLAUDE.local.md`, and `@file` imports are not implemented by this loader. The official [V1 rules page](https://opencode.ai/docs/rules/) documents fallback support, but its brief precedence list should not be read as the literal output order or as a nearest-file-only rule. **C, S, D**

The [filesystem helper](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/core/src/fs-util.ts) returns matches from the starting directory upward. [Git discovery](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/core/src/git.ts) selects the first `.git` encountered and uses `git rev-parse --show-toplevel`, including `.git` files used by linked worktrees. The [instance store](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/project/instance-store.ts) keeps the starting directory distinct from that worktree root. Launching inside a nested repository therefore excludes containing-repository instructions. Launching in an outer repository and reading inside a nested one can discover its instructions dynamically. **C, B**

`OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` disable both project and global Claude prompt fallbacks in the [runtime flags](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/effect/runtime-flags.ts). `OPENCODE_DISABLE_PROJECT_CONFIG=1` skips startup project instructions and resolves relative configured entries in the global instruction directory; it does not switch off the separate nearby resolver. **S, C**

## Dynamic delivery and its boundaries

The [read implementation](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/tool/read.ts) returns a directory listing before calling the nearby resolver. Normal text reads append nearby instructions in a `<system-reminder>` after file content. The resolver uses `current.startsWith(root)` rather than a path-component containment check: with permission allowed, reading a canonical absolute path such as `/tmp/example-neighbor/file.txt` from `/tmp/example` can attach the neighboring directory's instructions. The external-directory permission check still runs before loading. This was reproduced with isolated fixtures, rather than inferred solely from the condition. **B, C**

Nearby files are deduplicated by resolved path strings, not by content, inode, or content hash. Per-assistant-message claims prevent concurrent/repeated attachment, and completed `read` metadata suppresses later attachment while that history remains available. Editing a previously loaded nearby file does not defeat that dedupe. Clearing a message's claims permits another attachment when retained history does not already claim it. `time.compacted` read parts are ignored by the dedupe extractor. The [ordinary prompt loop](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/session/prompt.ts), [history filter](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/session/message-v2.ts), and [compaction/pruning implementation](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/session/compaction.ts) support rediscovery after relevant history disappears. Exact retention and instruction-following across a real compaction or resume remain unverified. **S, C, U**

Image/PDF reads take a separate return path: the source records nearby paths in `metadata.loaded` but does not append their instruction text to the returned result. Binary-file or invalid-offset failures can also occur after the resolver has made per-message claims. These are source-observed caveats, not completed model-canary tests. **C, U**

## Configured instructions and limits

The loader accepts file paths, globs, `~/` paths, absolute paths, and HTTP(S) URLs from `instructions`. Relative entries search every directory from the start through the worktree root. Absolute glob handling applies the pattern to the final path component in its fixed parent directory. Local paths are deduplicated against discovered paths. All local files precede URLs in the result, even when a URL appears earlier in the configuration array. Files are read in full; failures produce empty content. URLs use a five-second timeout around HTTP execution, with body reading handled separately; remote failure/timing was not probed. Configuration merging combines and deduplicates instruction arrays between config sources. **S for local resolution/order, C for URLs/config merging** ([loader](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/session/instruction.ts), [configuration](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/config/config.ts))

The read tool's 50 KiB file-content cap does not cap appended nearby instruction text. Its explicit `metadata.truncated` also makes the [general tool wrapper](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/opencode/src/tool/tool.ts) return that result without another truncation pass. The binary probe retained the final marker of a nearby instruction exceeding 100 KB. Provider context limits still apply; this probe establishes returned bytes, not model receipt, comprehension, or unlimited capacity. **B, C, U**

## Extension fit

The official [plugin guide](https://opencode.ai/docs/plugins/) documents local project/global plugins and npm plugins. The versioned [plugin interface](https://github.com/anomalyco/opencode/blob/v1.18.19/packages/plugin/src/index.ts) exposes `tool.execute.before` with mutable arguments, `tool.execute.after` with mutable output, `experimental.chat.system.transform` with a mutable system string array, `experimental.chat.messages.transform`, and `experimental.session.compacting` with context/prompt customization. Plugin input includes the starting directory, worktree, project, and SDK client. **C, D**

An agents-chain adapter could use these surfaces, but that is an architectural inference. They are not the same protocol as another agent runtime's shell hooks or `additionalContext` field. A tool-before handler's output only contains arguments; injecting context there is not a documented direct output. An adapter still needs separate design, provider-free unit tests, tool-timing checks, compaction tests, and an explicitly authorized installation. No plugin or configuration was installed by this assessment. **C, U**

## V2 is a separate contract

The [V2 instructions page](https://dev.opencode.ai/v2/docs/instructions/) describes home-bounded ambient traversal for projects under home, directory-listing discovery, only `AGENTS.md`, and ambient instruction updates represented in session history. Those are **V2 documentation claims**, not observations of the installed V1 binary. In particular, do not replace the V1 fallback, Git boundary, directory-listing, or update findings above with the V2 description. No V2 binary was evaluated. **D, U**

## Remaining verification gaps

No model/provider requests were made. Real model-visible startup ordering, instruction following, resume/revert behavior, provider compaction, remote instruction failures, installed plugin delivery, and worktree startup canaries remain unverified end-to-end. Startup and dedupe claims are deliberately labeled source-service evidence where no installed-binary inspection surface exposes the assembled system prompt without a model request. The harness does not run the full upstream suite or prove every supported platform behaves identically.
