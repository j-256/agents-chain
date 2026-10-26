#!/usr/bin/env node
// Adapt Codex lifecycle JSON to the shared AGENTS.md chain policy
import { runAgentsChainHook } from '../lib/agents-chain.mjs'
await runAgentsChainHook('codex', process.argv.slice(2))
