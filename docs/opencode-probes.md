# Reproduce OpenCode V1 instruction-loading probes

These probes use disposable local fixture files and never request a model completion. Run them outside a real project. Use the supplied scripts alongside this recipe. They require Git, Python 3, Bun, an OpenCode 1.18.19 executable, and network access to obtain official source and the pinned Effect dependency. Runtime probes use a dummy provider definition targeting an unavailable loopback port solely to satisfy tool-registry metadata; no provider call is issued.

## Obtain the matching source

```bash
probe_root="$(mktemp -d "${TMPDIR:-/tmp}/opencode-instructions.XXXXXX")"
git clone --depth 1 --branch v1.18.19 --single-branch https://github.com/anomalyco/opencode.git "$probe_root/source"
opencode --version
git -C "$probe_root/source" describe --tags --exact-match
```

Stop if the installed version differs. These assertions describe v1.18.19, not a moving branch or V2. The source-service harness uses Bun's bundler to execute the tagged `instruction.ts` with mocked Config, Global, RuntimeFlags, filesystem, instance state, and HTTP services. Its filesystem walking adapters preserve the tagged `FSUtil.findUp` and `globUp` algorithms. The HTTP stub rejects every request. This isolates instruction resolution and does not represent a full runtime launch.

## Run installed-binary tool probes

```bash
python3 research/opencode/probe-binary.py "$(command -v opencode)" "$probe_root/source" > "$probe_root/binary-results.json"
```

The script creates a scratch outer repository, nested repository, ordinary subdirectories, outside sibling paths, and unique instruction markers. It executes `opencode --pure debug agent build --tool ...` with a clean environment, scratch XDG paths, `OPENCODE_TEST_HOME`, disabled default plugins/model fetching/updating, and disabled LSP/formatting. It tests text-file reads, directory reads, shell `cat`, globbing, writes, nested-repository traversal, outside-prefix behavior, and a large instruction with an end marker. Fixture permissions explicitly allow scratch file operations; the outside-prefix test does not establish a permission bypass.

Results go to JSON on stdout. The script also retains individual debug outputs in its printed fixture location. Direct debug output is redirected to a regular file before parsing: piping a large debug result produced incomplete JSON in the evaluated binary, so pipe capture alone is not a reliable instruction-size measurement.

## Run the isolated source-service probes

Copy `probe-source.mts` into a scratch harness directory and install its dependency there, without invoking repository install scripts:

```bash
mkdir "$probe_root/harness"
cp research/opencode/probe-source.mts "$probe_root/harness/probe-source.mts"
npm install --prefix "$probe_root/harness" --ignore-scripts --no-audit --no-fund effect@4.0.0-beta.83
bun "$probe_root/harness/probe-source.mts" "$probe_root/source" > "$probe_root/source-results.json"
```

This checks startup filename priority, global fallback, leaf-to-root order, local configured entries, message/history dedupe, changed files, simulated pruned metadata, and project-config disabling. It does not call upstream model or auth services. Assertions fail with a nonzero status; only a successful final JSON report establishes completion. Both scripts support `-h` and `--help`. Exit statuses are 0 for success, 1 for runtime/assertion failure, 2 for usage or invalid source inputs, and 3 for a missing directly checked dependency.

## Optional provider-authorized canaries

The assessment deliberately stops before this stage. A separate provider-authorized experiment could verify the assembled startup prompt and actual delivery through a real tool loop, compaction, resume, and plugins. A model's recollection of a canary is weaker evidence than an inspected outbound request or captured tool result; repeat negative answers and preserve the exact prompts, tool transcript, versions, and capture method. Never point these tests at real credentials or real project instructions. Give the fixture session its own isolated storage/configuration and explicitly account for any model call and billing.
