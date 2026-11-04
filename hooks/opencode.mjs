#!/usr/bin/env node
// Instruction-engine entrypoint for normalized OpenCode lifecycle JSON, not a native plugin
import { runAgentsChainHook } from '../lib/agents-chain.mjs'
await runAgentsChainHook('opencode', process.argv.slice(2))
