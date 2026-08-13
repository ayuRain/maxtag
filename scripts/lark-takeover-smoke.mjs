#!/usr/bin/env node

process.argv.push('--control=takeover');
await import('./lark-stop-smoke.mjs');
