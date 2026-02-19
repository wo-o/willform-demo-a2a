#!/usr/bin/env tsx
// A2A Agent Demo — Test Agent ↔ Willy (Willform Agent)
// Usage: npm run agent

import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { A2AClient } from "./lib/a2a-client.js";
import { loadConfig } from "./lib/config.js";
import { fetchAgentCard, fetchOperations, type AgentCard, type OperationInfo } from "./lib/agent-card.js";

// Collected x402 handshake steps for display (reset before each send)
let x402Steps: string[] | null = null;

const AUTO_MODE = process.argv.includes("--auto");

const MODEL = "claude-sonnet-4-6";
const W = Math.max(72, Math.min(process.stdout.columns ?? 80, 110));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── CJK-aware width ─────────────────────────────────────────

function vw(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x1100 && cp <= 0x11ff) ||
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xff01 && cp <= 0xff60)
    ) { w += 2; } else { w += 1; }
  }
  return w;
}

function wrapText(text: string, maxVW: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let buf = "", bufVW = 0;
  for (const word of words) {
    const ww = vw(word);
    if (buf && bufVW + 1 + ww > maxVW) { lines.push(buf); buf = word; bufVW = ww; }
    else { if (buf) { buf += " "; bufVW += 1; } buf += word; bufVW += ww; }
  }
  if (buf) lines.push(buf);
  return lines.length ? lines : [""];
}

// ─── Primitives ───────────────────────────────────────────────

function hr(ch = "─") {
  process.stdout.write(chalk.gray(ch.repeat(W)) + "\n");
}

function startSpinner(text: string): () => void {
  if (!process.stdout.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(`\r  ${chalk.cyan(frames[i++ % frames.length])} ${chalk.gray(text)}`);
  }, 80);
  return () => {
    clearInterval(iv);
    process.stdout.write("\r" + " ".repeat(text.length + 6) + "\r");
  };
}

async function waitForEnter(msg: string) {
  if (!process.stdout.isTTY || AUTO_MODE) {
    if (AUTO_MODE) await sleep(1500);
    return;
  }
  process.stdout.write(chalk.gray(`\n  [ ${msg} ] `));
  await new Promise<void>((resolve) => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      if (ch === "\r" || ch === "\n" || ch === " ") {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve();
      } else if (ch === "\u0003") { process.exit(0); }
    };
    process.stdin.on("data", onData);
  });
}

// ─── A2A display ──────────────────────────────────────────────

function showScenarioHeader(idx: number, total: number, title: string) {
  hr("═");
  process.stdout.write(`  ${chalk.bold.yellow(`[${idx}/${total}]`)}  ${chalk.bold.white(title)}\n`);
  hr("═");
}

function showUserTurn(text: string) {
  hr();
  const prefixVW = vw("  ▶  ");
  const lines = wrapText(text, W - prefixVW - 2);
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      process.stdout.write(`  ${chalk.bold.white("▶")}  ${chalk.white(lines[i])}\n`);
    } else {
      process.stdout.write(`${" ".repeat(prefixVW)}${chalk.white(lines[i])}\n`);
    }
  }
  hr();
}

// Agent's execution plan (shown before API calls)
function showPlan(title: string, steps: string[]) {
  process.stdout.write(`  ${chalk.magenta("◈")} ${chalk.magenta.bold("Test Agent 계획")}  ${chalk.white(title)}\n`);
  for (let i = 0; i < steps.length; i++) {
    process.stdout.write(`    ${chalk.gray(`${i + 1}.`)} ${chalk.white(steps[i])}\n`);
  }
}

// Parse Willy response data into readable lines
function formatResponse(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [chalk.gray("(응답 없음)")];
  const obj = raw as Record<string, unknown>;
  const lines: string[] = [];
  if (obj.message && typeof obj.message === "string") {
    lines.push(chalk.gray(`"${obj.message}"`));
  }
  const inner = ("data" in obj && obj.data !== undefined) ? obj.data : raw;
  if (inner === null || inner === undefined) return lines.length ? lines : [chalk.gray("(데이터 없음)")];
  if (typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean") {
    lines.push(chalk.white(String(inner)));
    return lines;
  }
  if (Array.isArray(inner)) {
    if (inner.length === 0) { lines.push(chalk.gray("(빈 목록)")); return lines; }
    for (const item of inner.slice(0, 9)) {
      if (typeof item !== "object" || item === null) { lines.push(chalk.white(`  · ${item}`)); continue; }
      const it = item as Record<string, unknown>;
      const key = String(it.type ?? it.name ?? it.chart ?? it.id ?? it.namespace ?? Object.keys(it)[0] ?? "");
      const desc = String(it.description ?? it.status ?? it.workloadType ?? it.phase ?? "");
      const line = desc ? `  · ${key.padEnd(14)} ${desc}` : `  · ${key}`;
      lines.push(chalk.white(vw(line) > W - 4 ? line.slice(0, W - 5) + "…" : line));
    }
    if (inner.length > 9) lines.push(chalk.gray(`  · ... 외 ${inner.length - 9}개`));
    return lines;
  }
  if (typeof inner === "object") {
    const entries = Object.entries(inner as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, 8)) {
      if (v === null || v === undefined) continue;
      const valStr = typeof v === "object" ? JSON.stringify(v) : String(v);
      const line = `  ${chalk.gray(k.padEnd(16))} ${chalk.white(valStr)}`;
      lines.push(vw(line) > W - 2 ? line.slice(0, W - 3) + "…" : line);
    }
    return lines.length ? lines : [chalk.gray("{}")];
  }
  return [chalk.white(String(inner).slice(0, W - 4))];
}

// Syntax highlight for JSON
function highlightJson(line: string): string {
  return line
    .replace(/"([^"]+)":/g, chalk.cyan('"$1"') + chalk.gray(":"))
    .replace(/: "([^"]+)"/g, chalk.gray(": ") + chalk.yellow('"$1"'))
    .replace(/: (\d+)/g, chalk.gray(": ") + chalk.magenta("$1"))
    .replace(/: (true|false|null)/g, chalk.gray(": ") + chalk.blue("$1"));
}

// Single exchange box: outgoing top half
function printCallTop(
  reflection: string,
  narration: string,
  reason: string,
  operation: string,
  params: Record<string, unknown>,
) {
  process.stdout.write("\n");
  if (reflection) {
    // Speech bubble: prefix only on first line, indent continuation
    const prefixVW = vw("  ◉ Test Agent  ");
    const lines = wrapText(reflection, W - prefixVW - 2);
    for (let i = 0; i < lines.length; i++) {
      if (i === 0) {
        process.stdout.write(`  ${chalk.yellow("◉")} ${chalk.yellow.bold("Test Agent")}  ${chalk.yellow(lines[i])}\n`);
      } else {
        process.stdout.write(`${" ".repeat(prefixVW)}${chalk.yellow(lines[i])}\n`);
      }
    }
    process.stdout.write("\n");
  }
  process.stdout.write(
    `  ${chalk.cyan("◆")} ${chalk.cyan.bold("Test Agent 실행 결정")}  ${chalk.white(`"${narration}"`)}\n`,
  );
  if (reason) {
    for (const line of wrapText(reason, W - 10)) {
      process.stdout.write(`    ${chalk.gray("↳ " + line)}\n`);
    }
  }
  process.stdout.write("\n");
  const lineVW = W - 2;
  const label = " Test Agent ▶ Willy ";
  const opLabel = ` ${operation} `;
  const dashes = Math.max(1, lineVW - 1 - vw(label) - vw(opLabel));
  process.stdout.write(
    "  " + chalk.cyan("┌" + label) + chalk.gray("─".repeat(dashes)) + chalk.cyan(opLabel) + "\n",
  );
  process.stdout.write("  " + chalk.cyan("│") + chalk.gray("  POST /a2a  ·  x402  ·  agent.willform.ai") + "\n");

  // Show request payload with syntax highlighting
  const requestPayload = { operation, params };
  const payloadJson = JSON.stringify(requestPayload, null, 2);
  const payloadLines = payloadJson.split("\n");

  process.stdout.write("  " + chalk.cyan("│") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.bold.yellow("  📤 요청 메시지:") + "\n");
  for (const line of payloadLines) {
    const truncated = line.length > W - 8 ? line.slice(0, W - 9) + "…" : line;
    process.stdout.write("  " + chalk.cyan("│") + "    " + highlightJson(truncated) + "\n");
  }
  process.stdout.write("  " + chalk.cyan("│") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.bold.magenta("  🔐 x402 Handshake:") + "\n");
}

// Single exchange box: incoming bottom half (closes the box)
function printCallBottom(raw: unknown, ms: number, status: string, willyMsg = "", fullTask?: unknown) {
  const ok = status === "completed";
  const dot = ok ? chalk.green("✓") : chalk.red("✗");
  const lineVW = W - 2;
  const label = " Test Agent ◀ Willy ";
  const timing = ` ${ms}ms `;
  const dashes = Math.max(1, lineVW - 1 - vw(label) - vw(timing) - 1);
  process.stdout.write(
    "  " + chalk.cyan("├") + chalk.green(label) + chalk.gray("─".repeat(dashes)) + chalk.gray(timing) + dot + "\n",
  );

  // Show raw response structure with syntax highlighting
  if (fullTask) {
    process.stdout.write("  " + chalk.cyan("│") + "\n");
    process.stdout.write("  " + chalk.cyan("│") + chalk.bold.green("  📥 응답 메시지:") + "\n");

    // Pretty-print the task object, handling nested escaped JSON
    const formatTask = (obj: unknown, indent = 0): string[] => {
      const lines: string[] = [];
      const ind = "  ".repeat(indent);
      const maxWidth = W - 8 - ind.length;

      if (obj === null || obj === undefined) {
        lines.push(ind + "null");
      } else if (typeof obj === "string") {
        // Try to parse if it looks like JSON
        if (obj.startsWith("{") || obj.startsWith("[")) {
          try {
            const parsed = JSON.parse(obj);
            lines.push(ind + chalk.dim("(nested JSON) ") + chalk.yellow("↓"));
            lines.push(...formatTask(parsed, indent + 1));
          } catch {
            const short = vw(obj) > maxWidth - 2 ? obj.slice(0, maxWidth - 3) + "…" : obj;
            lines.push(ind + chalk.yellow(`"${short}"`));
          }
        } else {
          const short = vw(obj) > maxWidth - 2 ? obj.slice(0, maxWidth - 3) + "…" : obj;
          lines.push(ind + chalk.yellow(`"${short}"`));
        }
      } else if (typeof obj === "number") {
        lines.push(ind + chalk.magenta(String(obj)));
      } else if (typeof obj === "boolean") {
        lines.push(ind + chalk.blue(String(obj)));
      } else if (Array.isArray(obj)) {
        if (obj.length === 0) {
          lines.push(ind + "[]");
        } else {
          lines.push(ind + "[");
          for (let i = 0; i < obj.length; i++) {
            const itemLines = formatTask(obj[i], indent + 1);
            lines.push(...itemLines.map((l, idx) => idx === 0 ? l + (i < obj.length - 1 ? "," : "") : l));
          }
          lines.push(ind + "]");
        }
      } else if (typeof obj === "object") {
        const entries = Object.entries(obj as Record<string, unknown>);
        if (entries.length === 0) {
          lines.push(ind + "{}");
        } else {
          lines.push(ind + "{");
          for (let i = 0; i < entries.length; i++) {
            const [key, val] = entries[i];
            const keyLine = `${ind}  ${chalk.cyan(`"${key}"`)}: `;
            const valLines = formatTask(val, 0);
            const comma = i < entries.length - 1 ? "," : "";
            if (valLines.length === 1 && valLines[0].trim() !== "") {
              const combined = keyLine + valLines[0].trim() + comma;
              if (vw(combined) > W - 8) {
                lines.push(keyLine);
                lines.push(ind + "  " + valLines[0].trim() + comma);
              } else {
                lines.push(combined);
              }
            } else {
              lines.push(keyLine);
              for (let j = 0; j < valLines.length; j++) {
                const isLast = j === valLines.length - 1;
                lines.push(ind + "  " + valLines[j] + (isLast ? comma : ""));
              }
            }
          }
          lines.push(ind + "}");
        }
      }
      return lines;
    };

    const formattedLines = formatTask(fullTask, 1);
    const maxLines = 100; // Increased to show more data
    const maxLineVW = W - 7; // "  │  " = 5 visible chars
    for (const line of formattedLines.slice(0, maxLines)) {
      if (vw(line) > maxLineVW) {
        const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
        let w = 0, cutAt = 0;
        for (let i = 0; i < plain.length; i++) {
          const cp = plain.codePointAt(i) ?? 0;
          const cw = ((cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff01 && cp <= 0xff60)) ? 2 : 1;
          if (w + cw > maxLineVW - 1) break;
          w += cw; cutAt++;
        }
        process.stdout.write("  " + chalk.cyan("│") + "  " + plain.slice(0, cutAt) + "…\n");
      } else {
        process.stdout.write("  " + chalk.cyan("│") + "  " + line + "\n");
      }
    }
    if (formattedLines.length > maxLines) {
      process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`    ... (${formattedLines.length - maxLines}줄 생략)`) + "\n");
    }
    process.stdout.write("  " + chalk.cyan("│") + "\n");
    process.stdout.write("  " + chalk.cyan("│") + chalk.gray("  " + "╌".repeat(W - 6)) + "\n");
  }

  // Willy's natural language message (if present)
  if (willyMsg) {
    const prefixVW = vw("  ◎ Willy  ");
    const msgLines = wrapText(willyMsg, W - prefixVW - 6);
    for (let i = 0; i < msgLines.length; i++) {
      if (i === 0) {
        process.stdout.write("  " + chalk.cyan("│") + `  ${chalk.green("◎")} ${chalk.green.bold("Willy")}  ${chalk.white(msgLines[0])}\n`);
      } else {
        process.stdout.write("  " + chalk.cyan("│") + `  ${" ".repeat(prefixVW)}${chalk.white(msgLines[i])}\n`);
      }
    }
    process.stdout.write("  " + chalk.cyan("│") + chalk.gray("  " + "╌".repeat(W - 6)) + "\n");
  }
  // Structured data (strip message to avoid duplication)
  const dataRaw = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k !== "message"))
    : raw;
  const dataLines = formatResponse(dataRaw);
  process.stdout.write("  " + chalk.cyan("│") + chalk.bold.blue("  📊 해석된 데이터:") + "\n");
  for (const line of dataLines) {
    if (line === "") { process.stdout.write("  " + chalk.cyan("│") + "\n"); continue; }
    process.stdout.write("  " + chalk.cyan("│") + "  " + line + "\n");
  }
  process.stdout.write("  " + chalk.cyan("└" + "─".repeat(lineVW - 1)) + "\n");
  // Subtle separator between exchanges
  process.stdout.write(chalk.gray("  " + "╌".repeat(W - 4)) + "\n");
}

// Test Agent's final summary
function showAgentReply(text: string) {
  process.stdout.write(`  ${chalk.blue("◆")} ${chalk.blue.bold("Test Agent")}  ${chalk.blue("최종 응답:")}\n`);
  const maxVW = W - 4;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) { console.log(); continue; }
    const headMatch = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (headMatch) {
      const title = headMatch[1].replace(/\*\*(.*?)\*\*/g, "$1");
      process.stdout.write("\n" + chalk.bold.white(`  ${title}`) + "\n");
      continue;
    }
    if (/^[-─═]{3,}$/.test(trimmed)) continue;
    const listMatch = trimmed.match(/^([-*·]|\d+\.)\s+(.+)$/);
    const prefix = listMatch ? "  · " : "  ";
    const content = listMatch ? listMatch[2] : trimmed;
    const formatted = content.replace(/\*\*(.*?)\*\*/g, (_, m) => chalk.bold.white(m));
    const wrapped = wrapText(formatted, maxVW - vw(prefix));
    for (let i = 0; i < wrapped.length; i++) {
      process.stdout.write(chalk.white(i === 0 ? prefix + wrapped[i] : "    " + wrapped[i]) + "\n");
    }
  }
}

// ─── Agent Card Discovery Display ────────────────────────────

async function fetchAgentCardWithDisplay(baseUrl: string): Promise<AgentCard> {
  const lineVW = W - 2;
  const label = " Test Agent ▶ Willform ";
  const opLabel = " agent.json ";
  const dashes = Math.max(1, lineVW - 1 - vw(label) - vw(opLabel));

  process.stdout.write("\n");
  process.stdout.write(
    "  " + chalk.cyan("┌" + label) + chalk.gray("─".repeat(dashes)) + chalk.cyan(opLabel) + "\n",
  );

  const url = `${baseUrl.replace(/\/$/, "")}/.well-known/agent.json`;
  process.stdout.write("  " + chalk.cyan("│") + chalk.gray("  GET /.well-known/agent.json") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.bold.yellow("  📤 요청:") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`    ${baseUrl}`) + "\n");
  process.stdout.write("  " + chalk.cyan("│") + "\n");

  const t0 = Date.now();
  let card: AgentCard;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    card = (await res.json()) as AgentCard;
  } catch (e) {
    const ms = Date.now() - t0;
    const timing = ` ${ms}ms `;
    const dashes2 = Math.max(1, lineVW - 1 - vw(label) - vw(timing) - 1);
    process.stdout.write(
      "  " + chalk.cyan("├") + chalk.red(label.replace("▶", "◀")) + chalk.gray("─".repeat(dashes2)) + chalk.gray(timing) + chalk.red("✗") + "\n",
    );
    process.stdout.write("  " + chalk.cyan("│") + "\n");
    process.stdout.write("  " + chalk.cyan("│") + chalk.red("  ⚠ Agent card fetch failed") + "\n");
    process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`    ${e instanceof Error ? e.message : e}`) + "\n");
    process.stdout.write("  " + chalk.cyan("└" + "─".repeat(lineVW - 1)) + "\n");
    return { name: "unknown", skills: [] };
  }

  const ms = Date.now() - t0;
  const timing = ` ${ms}ms `;
  const dashes2 = Math.max(1, lineVW - 1 - vw(label) - vw(timing) - 1);
  process.stdout.write(
    "  " + chalk.cyan("├") + chalk.green(label.replace("▶", "◀")) + chalk.gray("─".repeat(dashes2)) + chalk.gray(timing) + chalk.green("✓") + "\n",
  );

  process.stdout.write("  " + chalk.cyan("│") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.bold.green("  📥 응답:") + "\n");
  const cardJson = JSON.stringify({ name: card.name, skills: `[${card.skills.length} skills]` }, null, 2);
  for (const line of cardJson.split("\n")) {
    process.stdout.write("  " + chalk.cyan("│") + chalk.dim("    " + line) + "\n");
  }

  process.stdout.write("  " + chalk.cyan("│") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.bold.blue("  📊 발견된 정보:") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`    · Agent명: ${card.name}`) + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`    · Skill 수: ${card.skills.length}개`) + "\n");
  if (card.skills.length > 0) {
    const examples = card.skills.slice(0, 3).map(s => s.id).join(", ");
    const more = card.skills.length > 3 ? ` ... 외 ${card.skills.length - 3}개` : "";
    process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`    · 예: ${examples}${more}`) + "\n");
  }

  process.stdout.write("  " + chalk.cyan("└" + "─".repeat(lineVW - 1)) + "\n");
  process.stdout.write(chalk.gray("  " + "╌".repeat(W - 4)) + "\n");

  return card;
}

// ─── Operation Discovery Display ────────────────────────────

async function fetchOperationsWithDisplay(client: A2AClient): Promise<OperationInfo[]> {
  const lineVW = W - 2;
  const label = " Test Agent ▶ Willy ";
  const opLabel = " ask_willy ";
  const dashes = Math.max(1, lineVW - 1 - vw(label) - vw(opLabel));

  process.stdout.write("\n");
  process.stdout.write(
    "  " + chalk.cyan("┌" + label) + chalk.gray("─".repeat(dashes)) + chalk.cyan(opLabel) + "\n",
  );
  process.stdout.write("  " + chalk.cyan("│") + chalk.gray("  POST /a2a  ·  x402  ·  agent.willform.ai") + "\n");

  const query = "What operations are available? List all available operations with their names and parameters in table format.";
  process.stdout.write("  " + chalk.cyan("│") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.bold.yellow("  📤 질의 메시지:") + "\n");

  // Wrap query text to fit within box
  const queryPrefix = "    \"";
  const querySuffix = "\"";
  const maxQueryWidth = W - 10 - vw(queryPrefix) - vw(querySuffix);
  const queryLines = wrapText(query, maxQueryWidth);

  for (let i = 0; i < queryLines.length; i++) {
    if (i === 0) {
      process.stdout.write("  " + chalk.cyan("│") + chalk.dim(queryPrefix + queryLines[i]) + "\n");
    } else if (i === queryLines.length - 1) {
      process.stdout.write("  " + chalk.cyan("│") + chalk.dim("    " + queryLines[i] + querySuffix) + "\n");
    } else {
      process.stdout.write("  " + chalk.cyan("│") + chalk.dim("    " + queryLines[i]) + "\n");
    }
  }

  process.stdout.write("  " + chalk.cyan("│") + "\n");

  const t0 = Date.now();
  const task = await client.sendText(query);
  const ms = Date.now() - t0;

  const timing = ` ${ms}ms `;
  const dashes2 = Math.max(1, lineVW - 1 - vw(label) - vw(timing) - 1);
  process.stdout.write(
    "  " + chalk.cyan("├") + chalk.green(label.replace("▶", "◀")) + chalk.gray("─".repeat(dashes2)) + chalk.gray(timing) + chalk.green("✓") + "\n",
  );

  const data = client.extractData(task);

  // Show artifacts metadata
  process.stdout.write("  " + chalk.cyan("│") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.bold.green("  📥 응답 구조:") + "\n");
  if (task.artifacts && task.artifacts.length > 0) {
    for (const art of task.artifacts) {
      process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`    · Artifact: ${art.name}`) + "\n");
      process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`      ID: ${art.artifactId}`) + "\n");
      if (art.parts) {
        for (const part of art.parts) {
          if (part.kind === "text" && part.text) {
            const preview = part.text.length > 60 ? part.text.slice(0, 60) + "..." : part.text;
            process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`      · text (${part.text.length} chars): ${preview}`) + "\n");
          }
        }
      }
    }
  }

  const rawText = task.artifacts?.[0]?.parts?.find((p) => p.kind === "text")?.text;

  // Extract reply for parsing
  let reply = "";
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      reply = (parsed?.data?.reply || parsed?.reply || "") as string;
    } catch {
      reply = ((data as Record<string, unknown>)?.data as Record<string, unknown>)?.reply as string ?? "";
    }
  }

  // Parse operations from markdown table
  const operations: OperationInfo[] = [];
  const lines = reply.split("\n");
  for (const line of lines) {
    // Skip headers and separators
    if (line.includes("---") || line.includes("Operation") || line.includes("**")) continue;
    if (!line.includes("|")) continue;

    // Extract table cells: | operation | params | description |
    const cells = line.split("|").map(c => c.trim()).filter(c => c.length > 0);
    if (cells.length < 2) continue;

    // Remove backticks from operation names (e.g., `namespace_create` -> namespace_create)
    const operation = cells[0].replace(/`/g, "");
    const params = cells.length > 1 ? cells[1].replace(/`/g, "") : "";
    const description = cells.length > 2 ? cells[2] : "";

    // Only accept valid operation names (lowercase with underscores)
    if (/^[a-z][a-z_]*$/.test(operation)) {
      operations.push({
        operation,
        params: params === "{}" || params === "-" ? "" : params,
        description,
      });
    }
  }

  process.stdout.write("  " + chalk.cyan("│") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.bold.blue("  📊 파싱 결과:") + "\n");
  process.stdout.write("  " + chalk.cyan("│") + chalk.white(`    ${operations.length}개 operation 발견 및 tool description 생성`) + "\n");
  process.stdout.write("  " + chalk.cyan("│") + "\n");
  for (const op of operations.slice(0, 8)) {
    const params = op.params && op.params !== "-" ? ` [${op.params}]` : "";
    const opLine = `    · ${op.operation}${params}`;
    // Wrap if too long
    if (vw(opLine) > W - 10) {
      process.stdout.write("  " + chalk.cyan("│") + chalk.gray(`    · ${op.operation}`) + "\n");
      if (params) {
        process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`      ${params}`) + "\n");
      }
    } else {
      process.stdout.write("  " + chalk.cyan("│") + chalk.gray(opLine) + "\n");
    }
  }
  if (operations.length > 8) {
    process.stdout.write("  " + chalk.cyan("│") + chalk.dim(`    · ... 외 ${operations.length - 8}개`) + "\n");
  }

  process.stdout.write("  " + chalk.cyan("└" + "─".repeat(lineVW - 1)) + "\n");
  process.stdout.write(chalk.gray("  " + "╌".repeat(W - 4)) + "\n");

  return operations;
}

// ─── x402 Logging Fetch ──────────────────────────────────────

function createX402LoggingClient(baseUrl: string): { walletAddress: string; client: A2AClient } {
  const privateKey = process.env.WALLET_PRIVATE_KEY as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  const addr = `${account.address.slice(0, 8)}...${account.address.slice(-4)}`;

  const interceptFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    // x402 passes second request as a Request object (init is undefined)
    const hasPaymentSig =
      input instanceof Request
        ? input.headers.has("payment-signature")
        : (() => {
            const h = init?.headers;
            if (h instanceof Headers) return h.has("PAYMENT-SIGNATURE");
            if (h != null && typeof h === "object") return "PAYMENT-SIGNATURE" in (h as Record<string, string>);
            return false;
          })();

    if (!hasPaymentSig) {
      x402Steps?.push(chalk.gray("    1. →") + chalk.dim(" POST /a2a") + chalk.gray("  (no auth)"));
    } else {
      x402Steps?.push(chalk.gray("    4. →") + chalk.dim(" POST /a2a") + chalk.yellow("  + PAYMENT-SIGNATURE"));
    }

    const res = await fetch(input as RequestInfo, init);

    if (res.status === 402) {
      x402Steps?.push(chalk.gray("    2. ←") + chalk.red(" 402 Payment Required"));
      x402Steps?.push(chalk.gray("    3. ✍") + chalk.dim(` Signing   from: ${addr}`));
    } else if (hasPaymentSig && res.status === 200) {
      x402Steps?.push(chalk.gray("    5. ←") + chalk.green(" 200 OK"));
    }

    return res;
  };

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(interceptFetch as typeof fetch, {
    schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
  });

  return {
    walletAddress: account.address,
    client: new A2AClient({ baseUrl, fetchWithPayment }),
  };
}

// ─── Core ────────────────────────────────────────────────────

const config = loadConfig();
const { walletAddress, client: a2aClient } = createX402LoggingClient(config.baseUrl);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildA2ATool(operations: OperationInfo[]): Anthropic.Tool {
  const opList = operations
    .map((op) => op.params
      ? `- ${op.operation}: ${op.description} [params: ${op.params}]`
      : `- ${op.operation}: ${op.description}`,
    )
    .join("\n");
  return {
    name: "a2a_call",
    description: `Call Willy (Willform Deploy Agent) via A2A protocol.\n\nAvailable operations:\n${opList}`,
    input_schema: {
      type: "object" as const,
      properties: {
        reflection: {
          type: "string",
          description: "Korean: what you learned from the PREVIOUS Willy response (omit for first call). e.g. '네임스페이스가 없어서 먼저 생성했습니다'",
        },
        narration: {
          type: "string",
          description: "Korean: what you are doing now. e.g. '네임스페이스를 먼저 확인할게요'",
        },
        reason: {
          type: "string",
          description: "Korean: WHY you chose this operation — cite the user request or a prior result.",
        },
        operation: { type: "string", description: "Operation name from the list above" },
        params: {
          type: "object",
          description: "Parameters. Reuse IDs from previous results.",
          additionalProperties: true,
        },
      },
      required: ["narration", "reason", "operation"],
    },
  };
}

// Plan tool: agent declares its steps before executing
function buildPlanTool(): Anthropic.Tool {
  return {
    name: "declare_plan",
    description: "Call this FIRST before any a2a_call to declare your multi-step execution plan. Shows the user your upfront reasoning.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Korean: short title for this plan" },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Korean: ordered list of steps you will execute",
        },
      },
      required: ["title", "steps"],
    },
  };
}

function buildSystemPrompt(card: AgentCard): string {
  return `You are Test Agent, an AI agent managing cloud deployments on the Willform platform.
You call Willy (${card.name}) via the a2a_call tool.

WORKFLOW — follow this order every time:
1. Call declare_plan FIRST to outline your execution steps.
2. Execute each step via a2a_call, chaining results from previous calls.
3. Reflect on each Willy response before the next call.
4. Give a concise Korean final reply after all calls complete.

Each a2a_call MUST include:
- "narration": conversational Korean — what you are doing now
- "reason": Korean — WHY you chose this operation (cite user request or prior result)
- "reflection": Korean — what you learned from the PREVIOUS Willy response (omit for first call)

Decision rules:
- Before creating a namespace, check if it already exists (namespace_list first)
- If no namespace exists, create one using the appropriate _create operation
- Always read error messages carefully — they tell you which operation to use
- Reuse IDs returned by previous calls — never fabricate or guess UUIDs
- Before creating a deployment, run the preflight check operation first
- After creating a deployment, always verify its status
- For diagnostics: fetch logs AND run diagnosis if status is not healthy
- Final reply: concise Korean summary, use · bullets, no markdown headers`;
}

async function executeCall(
  reflection: string,
  narration: string,
  reason: string,
  operation: string,
  params: Record<string, unknown>,
): Promise<string> {
  x402Steps = [];
  printCallTop(reflection, narration, reason, operation, params);
  await sleep(1200);
  const stop = startSpinner("Willy 처리 중...");
  const t0 = Date.now();
  try {
    const task = await a2aClient.send(operation, params);
    stop();
    const ms = Date.now() - t0;

    // Print collected x402 handshake steps inside the box
    for (const step of x402Steps) {
      process.stdout.write("  " + chalk.cyan("│") + step + "\n");
    }
    process.stdout.write("  " + chalk.cyan("│") + "\n");
    x402Steps = null;

    const data = a2aClient.extractData(task);
    // Extract Willy's natural language from artifact text
    let willyMsg = "";
    const rawText = task.artifacts?.[0]?.parts?.find((p) => p.kind === "text")?.text;
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const msg = parsed.message ?? parsed.data?.message ?? parsed.data?.reply;
          if (typeof msg === "string") willyMsg = msg;
        }
      } catch { /* ignore */ }
    }
    printCallBottom(data, ms, task.status.state, willyMsg, task);
    await sleep(1200);
    const result: Record<string, unknown> = { status: task.status.state, data };
    if (task.metadata?.lowBalanceWarning) result.warning = task.metadata.lowBalanceWarning.message;
    return JSON.stringify(result, null, 2);
  } catch (e) {
    stop();
    const ms = Date.now() - t0;

    // Still print x402 steps even on error
    for (const step of x402Steps ?? []) {
      process.stdout.write("  " + chalk.cyan("│") + step + "\n");
    }
    x402Steps = null;

    const errMsg = e instanceof Error ? e.message : String(e);
    printCallBottom({ error: errMsg }, ms, "failed", "", undefined);
    await sleep(1200);
    return JSON.stringify({ error: errMsg });
  }
}

async function runTurn(
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  systemPrompt: string,
): Promise<void> {
  while (true) {
    const stop = startSpinner("Test Agent 추론 중...");
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });
    stop();
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const tb = response.content.find((b) => b.type === "text");
      if (tb?.type === "text") {
        hr();
        showAgentReply(tb.text);
        hr();
      }
      break;
    }

    if (response.stop_reason === "tool_use") {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        if (block.name === "declare_plan") {
          const { title, steps } = block.input as { title: string; steps: string[] };
          showPlan(title, steps);
          results.push({ type: "tool_result", tool_use_id: block.id, content: "Plan acknowledged. Proceed with execution." });
          continue;
        }

        if (block.name === "a2a_call") {
          const { reflection, narration, reason, operation, params } = block.input as {
            reflection?: string;
            narration: string;
            reason: string;
            operation: string;
            params?: Record<string, unknown>;
          };
          const result = await executeCall(reflection ?? "", narration, reason ?? "", operation, params ?? {});
          results.push({ type: "tool_result", tool_use_id: block.id, content: result });

          // Wait for user before proceeding to next operation
          await waitForEnter("다음 operation — Enter");
          process.stdout.write("\n");
        }
      }
      messages.push({ role: "user", content: results });
    }
  }
}

// ─── Scenarios ────────────────────────────────────────────────

const SCENARIOS: { title: string; prompt: string }[] = [
  {
    title: "자연스러운 배포 플로우",
    prompt: "nginx 간단하게 하나 띄워줘",
  },
  {
    title: "이벤트 대비 스케일 아웃",
    prompt: "다음 주에 대규모 프로모션 이벤트가 있어서 트래픽이 많이 몰릴 것 같아. 현재 배포된 앱을 스케일 아웃해줘. 완료 후 배포 상태와 리소스 현황도 같이 확인해줘.",
  },
];

async function runScenarios(
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  systemPrompt: string,
) {
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i];
    showScenarioHeader(i + 1, SCENARIOS.length, s.title);
    showUserTurn(s.prompt);
    await waitForEnter("실행 — Enter");
    process.stdout.write("\n");
    await sleep(200);
    messages.push({ role: "user", content: s.prompt });
    await runTurn(messages, tools, systemPrompt);
    if (i < SCENARIOS.length - 1) {
      await waitForEnter(`다음: [${i + 2}/${SCENARIOS.length}] ${SCENARIOS[i + 1].title} — Enter`);
      process.stdout.write("\n");
    }
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required in .env");
    process.exit(1);
  }

  console.clear();
  const inner = W - 2;

  // Banner header
  const title = " A2A Agent Demo ";
  const pad = Math.floor((inner - title.length) / 2);
  process.stdout.write(chalk.cyan("┌" + "─".repeat(inner) + "┐") + "\n");
  process.stdout.write(
    chalk.cyan("│") + " ".repeat(pad) + chalk.bold.white(title) +
    " ".repeat(inner - pad - title.length) + chalk.cyan("│") + "\n",
  );
  process.stdout.write(chalk.cyan("├" + "─".repeat(inner) + "┤") + "\n");

  // Initialization steps
  process.stdout.write(chalk.cyan("│") + chalk.white("  🔍 초기화 중...") + " ".repeat(inner - 13) + chalk.cyan("│") + "\n");
  process.stdout.write(chalk.cyan("└" + "─".repeat(inner) + "┘") + "\n");

  // Show agent card discovery as detailed exchange
  const card = await fetchAgentCardWithDisplay(config.baseUrl);
  await waitForEnter("다음 단계: Operation 발견 — Enter");
  process.stdout.write("\n");

  // Show operation discovery as A2A exchange
  const operations = await fetchOperationsWithDisplay(a2aClient);
  await waitForEnter("다음 단계: 시나리오 시작 — Enter");

  // Resume banner for summary and server info
  process.stdout.write("\n");
  process.stdout.write(chalk.cyan("┌" + "─".repeat(inner) + "┐") + "\n");
  const summaryLine = `  ✓ 초기화 완료: Agent Card + ${operations.length}개 Operation 발견`;
  const summaryPad = Math.max(0, inner - vw(summaryLine));
  process.stdout.write(chalk.cyan("│") + chalk.green(summaryLine) + " ".repeat(summaryPad) + chalk.cyan("│") + "\n");
  process.stdout.write(chalk.cyan("│") + " ".repeat(inner) + chalk.cyan("│") + "\n");

  // Server info
  const rows: [string, string][] = [
    ["서버",       config.baseUrl],
    ["프로토콜",   "JSON-RPC 2.0 over HTTPS"],
    ["인증",       "x402 Payment (USDC on-chain)"],
    ["모델",       MODEL],
  ];
  process.stdout.write(chalk.cyan("├" + "─".repeat(inner) + "┤") + "\n");
  for (const [k, v] of rows) {
    const row = `  ${k.padEnd(6)}: ${v}`;
    const padRight = Math.max(0, inner - vw(row));
    process.stdout.write(chalk.cyan("│") + chalk.gray(row) + " ".repeat(padRight) + chalk.cyan("│") + "\n");
  }

  // Description
  process.stdout.write(chalk.cyan("├" + "─".repeat(inner) + "┤") + "\n");
  const why = [
    "  [A2A: Test Agent ↔ Willy (Willform Agent)]",
    "  스크립트 없이 Test Agent가 자율 판단합니다:",
    "  · 실행 전 계획 수립 → 단계별 체이닝 → 결과 분석",
    "  · 조건부 판단 (없으면 생성, 있으면 재사용)",
    "  · 구조화 JSON으로 Willy에게 operation 요청",
  ];
  for (const w of why) {
    const padRight = Math.max(0, inner - vw(w));
    process.stdout.write(chalk.cyan("│") + chalk.gray(w) + " ".repeat(padRight) + chalk.cyan("│") + "\n");
  }
  process.stdout.write(chalk.cyan("└" + "─".repeat(inner) + "┘") + "\n\n");

  await sleep(500);

  const tools = [buildA2ATool(operations), buildPlanTool()];
  const systemPrompt = buildSystemPrompt(card);
  const messages: Anthropic.MessageParam[] = [];

  try {
    await runScenarios(messages, tools, systemPrompt);
  } catch (e) {
    console.error(chalk.red(`오류: ${e instanceof Error ? e.message : e}`));
  }
}

main().catch(console.error);
