#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';

createServer().connect(new StdioServerTransport()).catch(error => { console.error(error); process.exitCode = 2; });
