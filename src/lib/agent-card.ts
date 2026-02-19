// Server discovery via A2A agent card

import type { A2AClient } from "./a2a-client.js";

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
}

export interface AgentCard {
  name: string;
  skills: AgentSkill[];
}

export interface OperationInfo {
  operation: string;
  params: string;
  description: string;
}

export async function fetchAgentCard(baseUrl: string): Promise<AgentCard> {
  const url = `${baseUrl.replace(/\/$/, "")}/.well-known/agent.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as AgentCard;
  } catch (e) {
    console.warn(
      `  ⚠ Agent card fetch failed (${e instanceof Error ? e.message : e}), assuming all skills available`,
    );
    return { name: "unknown", skills: [] };
  }
}

export async function fetchOperations(
  client: A2AClient,
  options?: { verbose?: boolean },
): Promise<OperationInfo[]> {
  try {
    const query = "What operations are available? List all available operations with their names and parameters in table format.";

    if (options?.verbose) {
      const chalk = await import("chalk").then((m) => m.default);
      process.stdout.write(chalk.cyan("  │") + chalk.dim("     Query: ") + chalk.white(`"${query}"`) + "\n");
    }

    const task = await client.sendText(query);
    const data = client.extractData(task);
    // @ts-expect-error - dynamic data structure
    const reply = (data?.data?.reply ?? data?.reply ?? "") as string;

    if (typeof reply !== "string" || reply === "") {
      console.warn("  ⚠ Failed to fetch operations from Willy (empty or invalid reply)");
      return [];
    }

    if (options?.verbose) {
      const chalk = await import("chalk").then((m) => m.default);
      const lines = reply.split("\n").slice(0, 5);
      process.stdout.write(chalk.cyan("  │") + chalk.dim("     Response (sample):") + "\n");
      for (const line of lines) {
        const truncated = line.length > 68 ? line.slice(0, 65) + "..." : line;
        process.stdout.write(chalk.cyan("  │") + chalk.dim("       " + truncated) + "\n");
      }
      if (reply.split("\n").length > 5) {
        process.stdout.write(chalk.cyan("  │") + chalk.dim(`       ... (${reply.split("\n").length - 5}줄 더)`) + "\n");
      }
    }

    // Parse markdown table - supports multiple formats:
    // Format 1: | `operation` | params | description |
    // Format 2: | Category | operation | params |
    const operations: OperationInfo[] = [];
    const lines = reply.split("\n");

    for (const line of lines) {
      // Skip header/separator lines
      if (line.includes("---") || line.includes("**Operation**") || line.includes("**Category**")) continue;

      // Try format 1: | `operation` | params | description |
      let match = line.match(/\|\s*`([^`]+)`\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/);
      if (match) {
        operations.push({
          operation: match[1].trim(),
          params: match[2].trim(),
          description: match[3].trim(),
        });
        continue;
      }

      // Try format 2: | **Category** | operation | params |  or  | | operation | params |
      match = line.match(/\|\s*(?:\*\*[^*]+\*\*|)\s*\|\s*([a-z_]+)\s*\|\s*([^|]+)\s*\|/);
      if (match && match[1] !== "") {
        operations.push({
          operation: match[1].trim(),
          params: match[2].trim(),
          description: "",
        });
      }
    }

    return operations;
  } catch (e) {
    console.warn(`  ⚠ Failed to fetch operations: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

export function availableSkillIds(card: AgentCard): Set<string> {
  return new Set(card.skills.map((s) => s.id));
}
