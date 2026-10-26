# Before/after probes

Run `node examples/probe.mjs` from the checkout. It creates private instructions, ordinary payloads, expected codes and temporary settings under home. It changes no runtime configuration and makes no model calls. Set `trial` to the printed root path. Keep expected.json out of the model's context. The start directory and target directories are siblings, so the target instructions are outside the native starting chain.

## Baseline

Start a fresh ordinary session with these hooks disabled for that process:

```bash
AGENTS_CHAIN_DISABLE=1 codex -C "$trial/start" --add-dir "$trial"
# Or, separately
(cd "$trial/start" && AGENTS_CHAIN_DISABLE=1 claude --add-dir "$trial")
```

Ask: "Using Bash, run cat ../read/data.txt. Report any read code in governing instructions already supplied to you. Do not open or search AGENTS.md, expected.json or other files, and do not guess a code."

The baseline should not know the randomized code. If it does, inspect the tool trace for direct reads, native loading or other instruction extensions. Repeat a negative result rather than relying on a single model recollection.

## Temporary live settings

These settings assume no other live registration of these hooks. Global hooks merge with session settings; do not run duplicate live copies. Existing log-only registrations can remain. Review changed Codex hooks through `/hooks`.

```bash
codex -C "$trial/start" --add-dir "$trial" \
  -c "$(cat "$trial/codex-start.toml")" \
  -c "$(cat "$trial/codex-override.toml")"

# Or, separately
(cd "$trial/start" && claude --add-dir "$trial" --settings "$trial/claude-settings.json")
```

Give the baseline read prompt again. The read code should match expected.json, without a direct instruction-file read. If the runtime saves hook output to a file, reading that saved payload is allowed and should be recorded separately from directly reading an instruction file.

Then ask: "Using Bash, run exactly printf 'probe-line\n' >> ../write/out.txt. If blocked, retry the identical tool invocation. Report the write code from supplied instructions. Do not read AGENTS.md or expected.json."

The first attempt should block, the identical retry should succeed, and out.txt should contain exactly one line. The write directory's instructions have not been delivered by the earlier read because it is a sibling. The log should have a live bounce and a subsequent retryOfMs. Use a fresh session and remove only the generated out.txt before repeating or changing runtimes; otherwise the line count is cumulative.

Finally ask: "Using Bash, run cat ../large/data.txt. Report the outline headings supplied by governing instructions and whether a body-only code is visible. Do not read AGENTS.md or expected.json."

The heading code and section titles should be visible; the body-only code should not be. The log must identify the file in capped. An outline proves delivery of metadata, not delivery of every rule in the file.

Compare codes and inspect the log yourself outside the agent session:

```bash
cat "$trial/expected.json"
wc -l "$trial/write/out.txt"
node agents-chain-report --file "$trial/codex-state/agents-chain/log.jsonl"
# For Claude use claude-state in that path
```

## Real project chains

Start outside a nested project, then access an ordinary file beneath several ancestor AGENTS files. Ask for concrete local policy facts without permitting instruction-file or Git-metadata reads; compare with the files yourself. Use separate fresh sessions for read-first and write-first cases. Reading the chain before a write can remove the very first-write block being tested. A write probe should create only a new, disposable untracked file and must not modify source or instruction files.

Preserve the exact versions, prompts, tool arguments, output and log mode. Log-only decisions can say bounce without blocking. A returned hook payload is not proof of model receipt or instruction following. Remove generated fixtures and retained private transcripts when they are no longer needed; none belong in a published repository.
