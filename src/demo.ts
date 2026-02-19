#!/usr/bin/env tsx
// Interactive A2A demo — menu-driven exploration of the Willform A2A protocol

import * as readline from "readline";
import chalk from "chalk";
import { A2AClient, type A2ATask } from "./lib/a2a-client.js";
import { loadConfig } from "./lib/config.js";
import { header, subheader, success, error, info, json, taskSummary, divider } from "./lib/display.js";

const config = loadConfig();
const client = new A2AClient(config);

// Session state
let currentNamespaceId: string | null = null;
let currentDeploymentId: string | null = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(chalk.cyan(`${question} `), resolve));
}

async function call(operation: string, params: Record<string, unknown> = {}): Promise<unknown> {
  process.stdout.write(chalk.gray(`  → ${operation}...`));
  try {
    const task = await client.send(operation, params);
    const data = client.extractData(task);
    process.stdout.write(chalk.green(" done\n"));
    taskSummary(task);
    return data;
  } catch (err) {
    process.stdout.write(chalk.red(" failed\n"));
    error(err instanceof Error ? err.message : String(err));
    return null;
  }
}

// Menu actions

async function checkBalance() {
  subheader("Credits Balance");
  const data = await call("credits_balance") as Record<string, unknown> | null;
  if (data) {
    info("Balance", `$${data.balance}`);
    if (data.estimatedRuntime) info("Est. Runtime", String(data.estimatedRuntime));
  }
}

async function listCharts() {
  subheader("Available Chart Types");
  const data = await call("chart_list") as Array<Record<string, unknown>> | null;
  if (data && Array.isArray(data)) {
    for (const chart of data) {
      console.log(`  ${chalk.bold(String(chart.type).padEnd(14))} ${chalk.gray(String(chart.description ?? ""))}`);
    }
  }
}

async function createNamespace() {
  subheader("Create Namespace");
  const name = await ask("  Namespace name:");
  const coresStr = await ask("  Allocated cores (default 2):");
  const cores = parseInt(coresStr) || 2;

  const data = await call("namespace_create", { name, allocatedCores: cores }) as Record<string, unknown> | null;
  if (data) {
    currentNamespaceId = String(data.id);
    success(`Namespace created: ${currentNamespaceId}`);
    info("Short ID", String(data.shortId));
    info("Name", String(data.name));
  }
}

async function listNamespaces() {
  subheader("Namespaces");
  const data = await call("namespace_list") as Array<Record<string, unknown>> | null;
  if (data && Array.isArray(data)) {
    if (data.length === 0) {
      info("Result", "No namespaces found");
      return;
    }
    for (const ns of data) {
      const status = ns.status === "active" ? chalk.green("active") : chalk.red(String(ns.status));
      console.log(`  ${chalk.bold(String(ns.shortId))}  ${String(ns.name).padEnd(20)} ${status}  cores=${ns.allocatedCores}`);
    }
    if (!currentNamespaceId && data.length > 0) {
      currentNamespaceId = String(data[0].id);
      console.log(chalk.gray(`  (auto-selected namespace: ${data[0].shortId})`));
    }
  }
}

async function getNamespace() {
  if (!currentNamespaceId) {
    const id = await ask("  Namespace ID:");
    currentNamespaceId = id;
  }
  subheader(`Namespace Detail: ${currentNamespaceId}`);
  const data = await call("namespace_get", { namespaceId: currentNamespaceId });
  if (data) json(data);
}

async function deleteNamespace() {
  if (!currentNamespaceId) {
    error("No namespace selected. List namespaces first.");
    return;
  }
  subheader(`Delete Namespace: ${currentNamespaceId}`);
  const confirm = await ask(`  Delete ${currentNamespaceId}? (y/N)`);
  if (confirm.toLowerCase() !== "y") return;
  await call("namespace_delete", { namespaceId: currentNamespaceId });
  currentNamespaceId = null;
  currentDeploymentId = null;
}

async function createDeployment() {
  if (!currentNamespaceId) {
    error("Create a namespace first.");
    return;
  }
  subheader("Create Deployment");
  const name = await ask("  Deployment name:");
  const image = await ask("  Container image (e.g., nginx:alpine):");
  const chartType = await ask("  Chart type (web/database/queue/cache/worker/cronjob/job/static-site, default web):") || "web";
  const portStr = await ask("  Port (default 8080):");
  const port = parseInt(portStr) || 8080;

  const data = await call("deploy_create", {
    namespaceId: currentNamespaceId,
    name,
    image,
    chartType,
    port,
  }) as Record<string, unknown> | null;

  if (data) {
    currentDeploymentId = String(data.deploymentId ?? data.id);
    success(`Deployment created: ${currentDeploymentId}`);
    info("Status", String(data.status));
  }
}

async function deployStatus() {
  if (!currentDeploymentId) {
    const id = await ask("  Deployment ID:");
    currentDeploymentId = id;
  }
  subheader(`Deployment Status: ${currentDeploymentId}`);
  const data = await call("deploy_status", { deploymentId: currentDeploymentId });
  if (data) json(data);
}

async function listDeployments() {
  if (!currentNamespaceId) {
    error("Select a namespace first.");
    return;
  }
  subheader("Deployments");
  const data = await call("deploy_list", { namespaceId: currentNamespaceId }) as Array<Record<string, unknown>> | null;
  if (data && Array.isArray(data)) {
    if (data.length === 0) {
      info("Result", "No deployments");
      return;
    }
    for (const d of data) {
      const status = d.status === "running" ? chalk.green("running") : chalk.yellow(String(d.status));
      console.log(`  ${chalk.bold(String(d.name).padEnd(20))} ${status}  ${d.image}  replicas=${d.replicas}`);
    }
    if (!currentDeploymentId && data.length > 0) {
      currentDeploymentId = String(data[0].id);
      console.log(chalk.gray(`  (auto-selected deployment: ${data[0].name})`));
    }
  }
}

async function deployLogs() {
  if (!currentDeploymentId) {
    error("Select a deployment first.");
    return;
  }
  subheader("Deployment Logs");
  const data = await call("deploy_logs", { deploymentId: currentDeploymentId }) as Record<string, unknown> | null;
  if (data) {
    const logs = data.logs ?? data;
    if (typeof logs === "string") {
      console.log(logs);
    } else {
      json(logs);
    }
  }
}

async function deployDiagnose() {
  if (!currentDeploymentId) {
    error("Select a deployment first.");
    return;
  }
  subheader("Deployment Diagnosis");
  const data = await call("deploy_diagnose", { deploymentId: currentDeploymentId });
  if (data) json(data);
}

async function deployScale() {
  if (!currentDeploymentId) {
    error("Select a deployment first.");
    return;
  }
  const replicasStr = await ask("  Target replicas:");
  const replicas = parseInt(replicasStr);
  if (isNaN(replicas)) {
    error("Invalid number");
    return;
  }
  subheader(`Scale to ${replicas} replicas`);
  await call("deploy_scale", { deploymentId: currentDeploymentId, replicas });
}

async function deployEvents() {
  if (!currentDeploymentId) {
    error("Select a deployment first.");
    return;
  }
  subheader("Deployment Events");
  const data = await call("deploy_events", { deploymentId: currentDeploymentId });
  if (data) json(data);
}

async function deployStop() {
  if (!currentDeploymentId) {
    error("Select a deployment first.");
    return;
  }
  subheader("Stop Deployment");
  await call("deploy_stop", { deploymentId: currentDeploymentId });
}

async function deployRestart() {
  if (!currentDeploymentId) {
    error("Select a deployment first.");
    return;
  }
  subheader("Restart Deployment");
  await call("deploy_restart", { deploymentId: currentDeploymentId });
}

async function deployDelete() {
  if (!currentDeploymentId) {
    error("Select a deployment first.");
    return;
  }
  const confirm = await ask(`  Delete deployment ${currentDeploymentId}? (y/N)`);
  if (confirm.toLowerCase() !== "y") return;
  await call("deploy_delete", { deploymentId: currentDeploymentId });
  currentDeploymentId = null;
}

// Main menu

const MENU = [
  { key: "1", label: "Check credits balance", fn: checkBalance },
  { key: "2", label: "List chart types", fn: listCharts },
  { key: "", label: "" },
  { key: "3", label: "Create namespace", fn: createNamespace },
  { key: "4", label: "List namespaces", fn: listNamespaces },
  { key: "5", label: "Get namespace detail", fn: getNamespace },
  { key: "6", label: "Delete namespace", fn: deleteNamespace },
  { key: "", label: "" },
  { key: "7", label: "Create deployment", fn: createDeployment },
  { key: "8", label: "List deployments", fn: listDeployments },
  { key: "9", label: "Deployment status", fn: deployStatus },
  { key: "10", label: "Deployment logs", fn: deployLogs },
  { key: "11", label: "Diagnose deployment", fn: deployDiagnose },
  { key: "12", label: "Scale deployment", fn: deployScale },
  { key: "13", label: "Deployment events", fn: deployEvents },
  { key: "14", label: "Stop deployment", fn: deployStop },
  { key: "15", label: "Restart deployment", fn: deployRestart },
  { key: "16", label: "Delete deployment", fn: deployDelete },
  { key: "", label: "" },
  { key: "q", label: "Quit" },
];

function showMenu() {
  header("Willform A2A Demo");
  info("Server", config.baseUrl);
  info("Wallet", config.walletAddress);
  if (currentNamespaceId) info("Namespace", currentNamespaceId);
  if (currentDeploymentId) info("Deployment", currentDeploymentId);
  divider();

  for (const item of MENU) {
    if (!item.key) {
      console.log();
      continue;
    }
    console.log(`  ${chalk.cyan(item.key.padEnd(4))} ${item.label}`);
  }
}

async function main() {
  header("Willform A2A Protocol Demo");
  console.log(chalk.gray("  Connecting to"), config.baseUrl);
  console.log(chalk.gray("  Wallet:"), config.walletAddress);
  console.log();

  while (true) {
    showMenu();
    const choice = await ask("\n  Select:");
    const item = MENU.find((m) => m.key === choice.trim());

    if (choice.trim() === "q") {
      console.log(chalk.gray("\nBye!\n"));
      rl.close();
      process.exit(0);
    }

    if (item?.fn) {
      try {
        await item.fn();
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    } else {
      error("Invalid selection");
    }

    await ask("\n  Press Enter to continue...");
  }
}

main();
