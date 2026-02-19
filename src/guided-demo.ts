#!/usr/bin/env tsx
// Guided A2A demo — step-by-step walkthrough of the full deployment lifecycle

import * as readline from "readline";
import chalk from "chalk";
import { A2AClient } from "./lib/a2a-client.js";
import { loadConfig } from "./lib/config.js";
import { header, subheader, success, error, info, json, divider } from "./lib/display.js";

const config = loadConfig();
const client = new A2AClient(config);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(chalk.cyan(`${question} `), resolve));
}

function explain(text: string) {
  console.log(chalk.gray(`  │ ${text}`));
}

async function step(num: number, title: string, description: string, fn: () => Promise<void>) {
  header(`Step ${num}: ${title}`);
  explain(description);
  console.log();
  await ask("Press Enter to execute...");
  await fn();
  console.log();
}

async function callAndShow(operation: string, params: Record<string, unknown> = {}): Promise<unknown> {
  console.log(chalk.gray(`  ─ Request ─────────────────────────────`));
  console.log(chalk.gray(`  POST /a2a`));
  console.log(chalk.gray(`  method: "message/send"`));
  console.log(chalk.gray(`  operation: "${operation}"`));
  if (Object.keys(params).length > 0) {
    console.log(chalk.gray(`  params: ${JSON.stringify(params)}`));
  }
  console.log(chalk.gray(`  ───────────────────────────────────────`));
  console.log();

  const task = await client.send(operation, params);
  const data = client.extractData(task);

  const stateColor = task.status.state === "completed" ? chalk.green : chalk.red;
  info("Task ID", task.id.slice(0, 8) + "...");
  info("Status", stateColor(task.status.state));
  info("Artifacts", String(task.artifacts?.length ?? 0));

  if (task.metadata?.lowBalanceWarning) {
    console.log(`  ${chalk.yellow("⚠")} ${task.metadata.lowBalanceWarning.message}`);
  }

  if (data) {
    subheader("Response Data");
    json(data);
  }

  return data;
}

async function main() {
  header("Willform A2A Protocol — Guided Demo");
  console.log(chalk.white.bold("  A2A (Agent-to-Agent) 프로토콜 실습 가이드"));
  console.log();
  info("Protocol", "JSON-RPC 2.0 over HTTP");
  info("Auth", "x402 Payment Protocol (dev bypass)");
  info("Server", config.baseUrl);
  info("Wallet", config.walletAddress);
  divider();
  console.log();
  explain("이 가이드는 A2A 프로토콜의 전체 배포 라이프사이클을 단계별로 보여줍니다.");
  explain("각 단계에서 실제 JSON-RPC 요청을 서버로 전송합니다.");
  console.log();
  await ask("Press Enter to start...");

  // Step 1: Check balance
  let balance = "";
  await step(1, "크레딧 잔액 확인", "A2A 요청에는 x402 결제 프로토콜 인증이 필요합니다. 먼저 현재 잔액을 확인합니다.", async () => {
    const data = await callAndShow("credits_balance") as Record<string, unknown> | null;
    if (data) balance = String(data.balance);
    success(`현재 잔액: $${balance}`);
  });

  // Step 2: List chart types
  await step(2, "차트 타입 조회", "Willform은 9가지 워크로드 타입을 지원합니다: web, database, queue, cache, storage, worker, cronjob, job, static-site", async () => {
    const data = await callAndShow("chart_list") as Array<Record<string, unknown>> | null;
    if (data && Array.isArray(data)) {
      subheader("지원 차트 타입");
      for (const chart of data) {
        console.log(`  ${chalk.cyan("●")} ${chalk.bold(String(chart.type).padEnd(14))} ${chalk.gray(String(chart.description ?? ""))}`);
      }
    }
  });

  // Step 3: Create namespace
  let namespaceId = "";
  let shortId = "";
  await step(3, "네임스페이스 생성", "배포를 위한 격리된 네임스페이스를 생성합니다. K8s 네임스페이스, 리소스 쿼터, NetworkPolicy가 자동으로 구성됩니다.", async () => {
    const data = await callAndShow("namespace_create", {
      name: "a2a-demo",
      allocatedCores: 2,
    }) as Record<string, unknown> | null;
    if (data) {
      namespaceId = String(data.id);
      shortId = String(data.shortId);
      success(`네임스페이스 생성 완료`);
      info("ID", namespaceId);
      info("Short ID", shortId);
      info("K8s NS", `${shortId}-user`);
    }
  });

  if (!namespaceId) {
    error("네임스페이스 생성 실패. 데모를 중단합니다.");
    rl.close();
    process.exit(1);
  }

  // Step 4: Deploy preflight
  await step(4, "배포 사전 검증 (Preflight)", "실제 배포 전에 이미지 접근성, 쿼터, 비용 등을 사전 검증합니다.", async () => {
    await callAndShow("deploy_preflight", {
      namespaceId,
      name: "demo-web",
      image: "nginx:alpine",
      chartType: "web",
      port: 80,
    });
    success("사전 검증 통과");
  });

  // Step 5: Create deployment
  let deploymentId = "";
  await step(5, "배포 생성", "nginx:alpine 이미지로 web 워크로드를 배포합니다. ArgoCD + Helm으로 K8s에 배포됩니다.", async () => {
    const data = await callAndShow("deploy_create", {
      namespaceId,
      name: "demo-web",
      image: "nginx:alpine",
      chartType: "web",
      port: 80,
    }) as Record<string, unknown> | null;
    if (data) {
      deploymentId = String(data.deploymentId ?? data.id);
      success(`배포 생성 완료: ${deploymentId}`);
      info("Status", String(data.status));
    }
  });

  if (!deploymentId) {
    error("배포 생성 실패. 데모를 중단합니다.");
    rl.close();
    process.exit(1);
  }

  // Step 6: Check status
  await step(6, "배포 상태 확인", "배포 상태, 리플리카, 도메인 정보를 확인합니다.", async () => {
    await callAndShow("deploy_status", { deploymentId });
  });

  // Step 7: Scale
  await step(7, "스케일링", "리플리카 수를 3으로 스케일합니다.", async () => {
    const data = await callAndShow("deploy_scale", {
      deploymentId,
      replicas: 3,
    }) as Record<string, unknown> | null;
    if (data) {
      success(`리플리카 수: ${data.replicas}`);
    }
  });

  // Step 8: Update env
  await step(8, "환경 변수 업데이트", "배포의 환경 변수를 추가/수정합니다.", async () => {
    await callAndShow("deploy_update_env", {
      deploymentId,
      env: { DEMO_KEY: "hello-a2a", NODE_ENV: "production" },
      merge: true,
    });
    success("환경 변수 업데이트 완료");
  });

  // Step 9: Diagnose
  await step(9, "배포 진단", "배포 상태를 진단하고 잠재적 문제를 식별합니다.", async () => {
    await callAndShow("deploy_diagnose", { deploymentId });
  });

  // Step 10: Events
  await step(10, "K8s 이벤트 조회", "배포와 관련된 Kubernetes 이벤트를 확인합니다.", async () => {
    await callAndShow("deploy_events", { deploymentId });
  });

  // Step 11: Stop and restart
  await step(11, "배포 중지 & 재시작", "배포를 중지했다가 다시 시작합니다. replicas=0으로 설정 후 복원합니다.", async () => {
    subheader("Stop");
    await callAndShow("deploy_stop", { deploymentId });
    console.log();
    await ask("  재시작하려면 Enter...");
    subheader("Restart");
    await callAndShow("deploy_restart", { deploymentId });
    success("배포 재시작 완료");
  });

  // Step 12: List deployments
  await step(12, "배포 목록 조회", "네임스페이스의 모든 배포를 조회합니다.", async () => {
    await callAndShow("deploy_list", { namespaceId });
  });

  // Step 13: Cleanup
  await step(13, "정리 (Cleanup)", "데모에서 생성한 리소스를 정리합니다.", async () => {
    const doCleanup = await ask("  리소스를 삭제할까요? (Y/n)");
    if (doCleanup.toLowerCase() !== "n") {
      subheader("Deleting deployment");
      await callAndShow("deploy_delete", { deploymentId });
      subheader("Deleting namespace");
      await callAndShow("namespace_delete", { namespaceId });
      success("정리 완료");
    } else {
      info("Skipped", "리소스가 유지됩니다.");
    }
  });

  // Step 14: Final balance
  await step(14, "최종 잔액 확인", "데모 후 크레딧 잔액 변화를 확인합니다.", async () => {
    const data = await callAndShow("credits_balance") as Record<string, unknown> | null;
    if (data) {
      const finalBalance = String(data.balance);
      info("시작 잔액", `$${balance}`);
      info("현재 잔액", `$${finalBalance}`);
      const diff = parseFloat(balance) - parseFloat(finalBalance);
      if (diff > 0) {
        info("사용 금액", `$${diff.toFixed(8)}`);
      }
    }
  });

  header("Demo Complete!");
  console.log(chalk.white.bold("  A2A 프로토콜 실습을 완료했습니다."));
  console.log();
  explain("학습한 내용:");
  explain("• JSON-RPC 2.0 기반 A2A 프로토콜 구조");
  explain("• x402 결제 프로토콜을 통한 인증");
  explain("• 네임스페이스 → 배포 → 관리의 전체 라이프사이클");
  explain("• 스케일링, 환경 변수, 진단 등의 관리 작업");
  console.log();
  explain("추가 탐색:");
  explain("• pnpm demo — 인터랙티브 메뉴 모드");
  explain("• pnpm a2a <operation> [params] — 단일 명령 실행");
  console.log();

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  rl.close();
  process.exit(1);
});
