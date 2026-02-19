import chalk from "chalk";
import type { A2ATask } from "./a2a-client.js";

export function header(text: string) {
  console.log(`\n${chalk.cyan("━".repeat(60))}`);
  console.log(chalk.cyan.bold(` ${text}`));
  console.log(`${chalk.cyan("━".repeat(60))}\n`);
}

export function subheader(text: string) {
  console.log(`\n${chalk.yellow("─")} ${chalk.yellow.bold(text)}`);
}

export function success(msg: string) {
  console.log(`  ${chalk.green("✓")} ${msg}`);
}

export function error(msg: string) {
  console.log(`  ${chalk.red("✗")} ${msg}`);
}

export function info(label: string, value: string) {
  console.log(`  ${chalk.gray(label.padEnd(16))} ${value}`);
}

export function json(data: unknown) {
  console.log(chalk.gray(JSON.stringify(data, null, 2)));
}

export function taskSummary(task: A2ATask) {
  const stateColor = task.status.state === "completed" ? chalk.green : chalk.red;
  info("Task ID", task.id);
  info("Status", stateColor(task.status.state));
  if (task.metadata?.lowBalanceWarning) {
    console.log(`  ${chalk.yellow("⚠")} ${task.metadata.lowBalanceWarning.message}`);
  }
}

export function divider() {
  console.log(chalk.gray("─".repeat(40)));
}

export function prompt(text: string) {
  process.stdout.write(chalk.cyan(`\n${text} `));
}
