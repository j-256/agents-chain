#!/usr/bin/env python3
"""Provider-free OpenCode V1 debug-tool probes using isolated disposable fixtures"""
from pathlib import Path
import argparse
import json
import shutil
import os
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__, epilog='Requires Git and an OpenCode 1.18.19 binary plus its pinned source checkout. Results: JSON on stdout; diagnostics on stderr. Exit: 0 success, 1 runtime or assertion failure, 2 usage/precondition error, 3 missing dependency. Creates disposable fixtures under the system temporary directory and does not contact a model provider.')
parser.add_argument('binary', help='OpenCode executable path')
parser.add_argument('source', help='Matching v1.18.19 source checkout')
args = parser.parse_args()
binary = str(Path(args.binary).absolute())
source = Path(args.source).absolute()
if not shutil.which('git') or not os.access(binary, os.X_OK):
    print('Missing dependency: Git or the supplied OpenCode executable', file=sys.stderr)
    sys.exit(3)
if not (source / 'packages/opencode/test/tool/fixtures/models-api.json').is_file():
    parser.error('source checkout lacks the required model-metadata fixture')
root = Path(tempfile.mkdtemp(prefix='opencode-instruction-binary-')).resolve()
for item in ['home', 'config/opencode', 'data', 'cache', 'state', 'managed', 'outer/inner/sub/deep', 'outer/inner-neighbor', 'elsewhere']:
    (root / item).mkdir(parents=True, exist_ok=True)
for item, word in [('outer', 'OUTER'), ('outer/inner', 'ROOT'), ('outer/inner/sub', 'SUB'), ('outer/inner/sub/deep', 'DEEP'), ('outer/inner-neighbor', 'PREFIX_SIBLING'), ('elsewhere', 'OUTSIDE')]:
    (root / item / 'AGENTS.md').write_text('Instruction canary: ' + word + '\n')
for item in ['outer/inner/sub/deep/file.txt', 'outer/inner-neighbor/file.txt', 'elsewhere/file.txt']:
    (root / item).write_text('ordinary sample file\n')
for item in ['outer', 'outer/inner']:
    subprocess.run(['git', 'init', '--quiet', str(root / item)], check=True, capture_output=True)
config = {
    'model': 'fixture/fixture',
    'provider': {'fixture': {'npm': '@ai-sdk/openai-compatible', 'name': 'Fixture', 'options': {'baseURL': 'http://127.0.0.1:1/v1', 'apiKey': 'unused-fixture-value'}, 'models': {'fixture': {'name': 'Fixture', 'limit': {'context': 100000, 'output': 1000}}}}},
    'permission': {'*': 'allow'}, 'lsp': False, 'formatter': False,
}
(root / 'config/opencode/opencode.json').write_text(json.dumps(config))
env = {
    'PATH': os.environ['PATH'],
    'XDG_DATA_HOME': str(root / 'data'), 'XDG_CONFIG_HOME': str(root / 'config'),
    'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_STATE_HOME': str(root / 'state'),
    'OPENCODE_TEST_HOME': str(root / 'home'), 'OPENCODE_TEST_MANAGED_CONFIG_DIR': str(root / 'managed'),
    'OPENCODE_DISABLE_DEFAULT_PLUGINS': '1', 'OPENCODE_DISABLE_MODELS_FETCH': '1',
    'OPENCODE_DISABLE_AUTOUPDATE': '1', 'OPENCODE_PURE': '1', 'NO_COLOR': '1',
    'OPENCODE_MODELS_PATH': str(source / 'packages/opencode/test/tool/fixtures/models-api.json'),
}
checks = []
def invoke(name, tool, params, cwd='outer/inner', expected=None, tail=None):
    command = [binary, '--pure', 'debug', 'agent', 'build', '--tool', tool, '--params', json.dumps(params)]
    output_file = root / (name + '.json')
    with output_file.open('w') as out:
        p = subprocess.run(command, cwd=root / cwd, env=env, text=True, stdout=out, stderr=subprocess.PIPE, timeout=90)
    p.stdout = output_file.read_text()
    if p.returncode:
        raise RuntimeError(name + '\n' + p.stderr[-2000:] + '\n' + p.stdout[-2000:])
    result = json.loads(p.stdout)['result']
    loaded = result.get('metadata', {}).get('loaded', [])
    labels = [str(Path(x).relative_to(root.resolve())) for x in loaded]
    has_reminder = '<system-reminder>' in result.get('output', '')
    if expected is not None:
        assert labels == expected, (name, labels, expected)
    check = {'name': name, 'tool': tool, 'loaded': labels, 'instructionReminder': has_reminder, 'truncated': result.get('metadata', {}).get('truncated'), 'outputBytes': len(result.get('output', '').encode()), 'exit': p.returncode}
    if tail:
        check['tailCanaryPresent'] = tail in result['output']
        assert check['tailCanaryPresent'], name
    checks.append(check)
invoke('read-file-loads-nearest-first', 'read', {'filePath': 'sub/deep/file.txt'}, expected=['outer/inner/sub/deep/AGENTS.md', 'outer/inner/sub/AGENTS.md'])
invoke('read-directory-does-not-load-nearby-instructions', 'read', {'filePath': 'sub/deep'}, expected=[])
invoke('bash-cat-does-not-load-nearby-instructions', 'bash', {'command': 'cat sub/deep/file.txt'})
assert checks[-1]['instructionReminder'] is False
invoke('glob-does-not-load-nearby-instructions', 'glob', {'pattern': 'sub/**/*.txt'})
assert checks[-1]['instructionReminder'] is False
invoke('write-does-not-load-nearby-instructions', 'write', {'filePath': 'sub/deep/new.txt', 'content': 'fixture write\n'})
assert checks[-1]['instructionReminder'] is False
invoke('outside-without-shared-prefix-does-not-load', 'read', {'filePath': str(root / 'elsewhere/file.txt')}, expected=[])
invoke('prefix-sibling-is-treated-as-inside-by-resolver', 'read', {'filePath': str(root / 'outer/inner-neighbor/file.txt')}, expected=['outer/inner-neighbor/AGENTS.md'])
invoke('dynamic-read-crosses-a-nested-git-root', 'read', {'filePath': 'inner/sub/deep/file.txt'}, cwd='outer', expected=['outer/inner/sub/deep/AGENTS.md', 'outer/inner/sub/AGENTS.md', 'outer/inner/AGENTS.md'])
(root / 'outer/inner/sub/deep/AGENTS.md').write_text('LARGE_BEGIN\n' + 'x' * 100000 + '\nLARGE_END')
invoke('large-instruction-bypasses-read-content-cap', 'read', {'filePath': 'sub/deep/file.txt'}, expected=['outer/inner/sub/deep/AGENTS.md', 'outer/inner/sub/AGENTS.md'], tail='LARGE_END')
assert checks[-1]['outputBytes'] > 100000 and checks[-1]['truncated'] is False
print(json.dumps({'mode': 'installed binary debug tool execution; no model/provider call', 'version': subprocess.check_output([binary, '--version'], env=env, text=True).strip(), 'fixture': str(root), 'checks': checks}, indent=2))
