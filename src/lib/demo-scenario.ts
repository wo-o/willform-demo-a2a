// Demo scenario configuration — edit these values to customise the live demo

export const AGENT_NAME = "Test Agent";
export const SERVER_AGENT_NAME = "Willy";

export const NAMESPACE = {
  name: "a2a-demo",
  allocatedCores: 2,
} as const;

export const DEPLOYMENT = {
  name: "demo-web",
  image: "nginx:alpine",
  chartType: "web",
  port: 80,
} as const;

export const SCALE = {
  replicas: 3,
} as const;

export const TIMING = {
  typewriteMs: 35,
  wireStepMs: 80,
  spinnerMs: 80,
  preShowPauseMs: 2000,
} as const;

export const LAYOUT = {
  contentWidth: 48,
  sendIndentSpaces: 4,
  deployIndentSpaces: 16,
  paymentBoxWidth: 21,
} as const;
