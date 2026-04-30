#!/usr/bin/env bun
/**
 * Kimi CLI - AI Agent for Terminal
 * Entry point (corresponds to Python __main__.py)
 */

import { cli } from "./cli/index.ts";

const exitCode = await cli(process.argv);
process.exit(exitCode);
