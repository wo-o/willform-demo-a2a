#!/usr/bin/env tsx
// Single-shot A2A CLI — send one operation from the command line
//
// Usage:
//   npx tsx src/cli.ts <operation> [JSON params]
//
// Examples:
//   npx tsx src/cli.ts credits_balance
//   npx tsx src/cli.ts chart_list
//   npx tsx src/cli.ts namespace_create '{"name":"demo","allocatedCores":2}'
//   npx tsx src/cli.ts deploy_status '{"deploymentId":"abc-123"}'

import { A2AClient } from "./lib/a2a-client.js";
import { loadConfig } from "./lib/config.js";
import { fetchOperations } from "./lib/agent-card.js";

const config = loadConfig();
const client = new A2AClient(config);

const [operation, paramsJson] = process.argv.slice(2);

if (!operation || operation === "--help") {
  console.log("Usage: npx tsx src/cli.ts <operation> [JSON params]");
  console.log("\nFetching available operations from server...\n");

  try {
    const operations = await fetchOperations(client);
    console.log("Operations:");
    const maxOpLen = Math.max(...operations.map((op) => op.operation.length));
    for (const op of operations) {
      const opPadded = op.operation.padEnd(maxOpLen + 2);
      const paramsStr = op.params ? `[${op.params}]` : "";
      console.log(`  ${opPadded}${op.description} ${paramsStr}`);
    }
  } catch (err) {
    console.error(`Error fetching operations: ${err instanceof Error ? err.message : err}`);
  }
  process.exit(0);
}

const params = paramsJson ? JSON.parse(paramsJson) : {};

try {
  const task = await client.send(operation, params);
  const data = client.extractData(task);

  console.log(JSON.stringify({
    status: task.status.state,
    data,
  }, null, 2));

  if (task.metadata?.lowBalanceWarning) {
    console.error(`\n⚠ ${task.metadata.lowBalanceWarning.message}`);
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
