#!/usr/bin/env node
// Adapt Claude lifecycle JSON to the shared AGENTS.md chain policy
import { runAgentsChainHook } from '../lib/agents-chain.mjs'
await runAgentsChainHook('claude', process.argv.slice(2))
