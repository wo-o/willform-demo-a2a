// Terminal animation and box-drawing utilities for the live demo

import * as readline from "readline";
import chalk from "chalk";
import {
  TIMING,
  LAYOUT,
  AGENT_NAME,
  SERVER_AGENT_NAME,
} from "./demo-scenario.js";

// ─── Primitives ─────────────────────────────────────────────

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(chalk.gray("\n        [Enter] 다음 단계 →  "));
    rl.once("line", () => {
      rl.close();
      resolve();
    });
  });
}

export function askInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.cyan(`        ${prompt} `), (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function askChoice(
  prompt: string,
  options: Array<{ key: string; label: string; desc: string }>,
): Promise<string> {
  console.log(chalk.cyan(`\n        ${prompt}`));
  for (const opt of options) {
    console.log(chalk.white(`          ${opt.key}) ${opt.label}`) + chalk.gray(` — ${opt.desc}`));
  }
  const answer = await askInput("선택:");
  const match = options.find((o) => o.key === answer.trim());
  return match?.key ?? options[0].key;
}

// ─── String width (CJK-aware) ───────────────────────────────

export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3040 && code <= 0x309f) ||
    (code >= 0x30a0 && code <= 0x30ff) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x3200 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd)
  )
    return 2;
  return 1;
}

export function strWidth(s: string): number {
  let w = 0;
  for (const c of s) w += charWidth(c);
  return w;
}

export function padW(s: string, width: number): string {
  const sw = strWidth(s);
  if (sw <= width) return s + " ".repeat(width - sw);
  // Truncate to fit within box
  let w = 0;
  let result = "";
  for (const c of s) {
    const cw = charWidth(c);
    if (w + cw > width - 1) break;
    result += c;
    w += cw;
  }
  return result + "…" + " ".repeat(Math.max(width - w - 1, 0));
}

export function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (strWidth(raw) <= maxWidth) {
      lines.push(raw);
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const word of raw.split(/(\s+)/)) {
      const ww = strWidth(word);
      if (currentWidth + ww > maxWidth && current) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      current += word;
      currentWidth += ww;
    }
    if (current) lines.push(current);
  }
  return lines;
}

// ─── Data unwrapping ────────────────────────────────────────

export function unwrap(d: unknown): Record<string, unknown> {
  const outer = d as Record<string, unknown> | null;
  const inner = outer?.data;
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return outer ?? {};
}

export function unwrapArray(d: unknown): Array<Record<string, unknown>> {
  const outer = d as Record<string, unknown> | null;
  const inner = outer?.data;
  if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
  if (Array.isArray(outer)) return outer as Array<Record<string, unknown>>;
  return [];
}

// ─── Animation ──────────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export async function typewrite(text: string, ms = TIMING.typewriteMs): Promise<void> {
  for (const ch of text) {
    process.stdout.write(ch);
    await sleep(ms);
  }
}

export async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(
      `\r        ${chalk.cyan(SPINNER[i++ % SPINNER.length])} ${chalk.gray(label)}`,
    );
  }, TIMING.spinnerMs);
  try {
    const result = await fn();
    clearInterval(id);
    process.stdout.write(
      `\r        ${chalk.green("✓")} ${chalk.gray(label)}${"".padEnd(20)}\n`,
    );
    return result;
  } catch (e) {
    clearInterval(id);
    process.stdout.write(
      `\r        ${chalk.red("✗")} ${chalk.gray(label)}${"".padEnd(20)}\n`,
    );
    throw e;
  }
}

export async function wireRight(): Promise<void> {
  const steps = ["─", "──", "───", "────", "─────", "──────▶"];
  for (const s of steps) {
    process.stdout.write(`\r${SEND_INDENT}${chalk.cyan(s)}`);
    await sleep(TIMING.wireStepMs);
  }
  process.stdout.write("\n");
}

export async function wireLeft(): Promise<void> {
  const steps = [
    "              ─",
    "           ────",
    "        ───────",
    "     ──────────",
    "  ─────────────",
    "◀──────────────",
  ];
  for (const s of steps) {
    process.stdout.write(`\r${DEPLOY_INDENT}${chalk.green(s)}`);
    await sleep(TIMING.wireStepMs);
  }
  process.stdout.write("\n");
}

// ─── Box Drawing ────────────────────────────────────────────

const { contentWidth: CW } = LAYOUT;
const SEND_INDENT = " ".repeat(LAYOUT.sendIndentSpaces);
const DEPLOY_INDENT = " ".repeat(LAYOUT.deployIndentSpaces);

export const BOX_RULE = "─".repeat(CW);

export function kv(key: string, val: unknown, keyW = 12): string {
  const valStr = String(val ?? "N/A");
  const gap = Math.max(keyW - strWidth(key), 1);
  return `  ${key}${" ".repeat(gap)}${valStr}`;
}

export async function devopsBoxTyping(lines: string[]): Promise<void> {
  const label = `─ ${AGENT_NAME} `;
  const fill = "─".repeat(CW + 2 - label.length);
  process.stdout.write(chalk.blue(`  ┌${label}${fill}┐`) + "\n");
  for (const line of lines) {
    process.stdout.write(chalk.blue("  │") + " ");
    await typewrite(line);
    const remaining = CW - strWidth(line);
    process.stdout.write(" ".repeat(Math.max(remaining, 0)) + " " + chalk.blue("│") + "\n");
  }
  process.stdout.write(chalk.blue(`  └${"─".repeat(CW + 2)}┘`) + "\n");
}

export function deployBox(lines: string[]): void {
  const label = `─ ${SERVER_AGENT_NAME} `;
  const fill = "─".repeat(CW + 2 - label.length);
  console.log(chalk.green(`${DEPLOY_INDENT}┌${label}${fill}┐`));
  for (const line of lines) {
    // Wrap lines that exceed box width; padW truncates as last resort
    const wrapped = strWidth(line) > CW ? wrapText(line, CW) : [line];
    for (const wl of wrapped) {
      console.log(chalk.green(`${DEPLOY_INDENT}│`) + ` ${padW(wl, CW)} ` + chalk.green("│"));
    }
  }
  console.log(chalk.green(`${DEPLOY_INDENT}└${"─".repeat(CW + 2)}┘`));
}

export function paymentBox(walletAddress: string): void {
  const short = walletAddress.slice(0, 6) + ".." + walletAddress.slice(-3);
  const pw = LAYOUT.paymentBoxWidth;
  const border = "═".repeat(pw);
  console.log(chalk.yellow(`${SEND_INDENT}╔═══ x402 Payment ════╗`));
  console.log(chalk.yellow(`${SEND_INDENT}║${(` wallet: ${short}`).padEnd(pw)}║`));
  console.log(chalk.yellow(`${SEND_INDENT}║${" → POST /a2a".padEnd(pw)}║`));
  console.log(chalk.yellow(`${SEND_INDENT}╚${border}╝`));
}

export function sectionDivider(): void {
  const dash = "┈ ".repeat(24).trimEnd();
  console.log();
  console.log(chalk.gray(`  ${dash}`));
  console.log();
}

export function stateBar(final: string): void {
  const states = ["submitted", "working", final];
  const parts = states.map((s, i) =>
    i === states.length - 1 ? chalk.green.bold(s) : chalk.gray(s),
  );
  console.log(`${DEPLOY_INDENT}${parts.join(chalk.gray(" → "))}`);
}
