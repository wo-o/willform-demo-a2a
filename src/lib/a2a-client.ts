// A2A JSON-RPC 2.0 client for Willform Deploy Agent

export interface A2AClientConfig {
  baseUrl: string;
  fetchWithPayment: typeof fetch;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: { state: string; timestamp: string };
  artifacts: Array<{
    artifactId: string;
    name: string;
    parts: Array<{ kind: string; text: string }>;
  }>;
  history: Array<{ state: string; timestamp: string; message?: string }>;
  metadata?: { lowBalanceWarning?: { balance: string; message: string } };
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: A2ATask;
  error?: { code: number; message: string };
  id: string | number;
}

export class A2AClient {
  private baseUrl: string;
  private fetch: typeof fetch;
  private rpcId = 0;

  constructor(config: A2AClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.fetch = config.fetchWithPayment;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const res = await this.fetch(`${this.baseUrl}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id: ++this.rpcId,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return res.json() as Promise<JsonRpcResponse>;
  }

  async sendText(text: string, contextId?: string): Promise<A2ATask> {
    const rpcParams: Record<string, unknown> = {
      message: {
        role: "user",
        parts: [{ kind: "text", text }],
      },
    };
    if (contextId) rpcParams.contextId = contextId;

    const response = await this.rpc("message/send", rpcParams);

    if (response.error) {
      throw new Error(`A2A error [${response.error.code}]: ${response.error.message}`);
    }
    if (!response.result) {
      throw new Error("Empty response from A2A endpoint");
    }

    return response.result;
  }

  extractText(task: A2ATask): string {
    if (!task.artifacts?.length) return "(응답 없음)";
    const textPart = task.artifacts[0].parts.find((p) => p.kind === "text");
    if (!textPart?.text) return "(응답 없음)";
    try {
      const parsed = JSON.parse(textPart.text);
      if (typeof parsed === "string") return parsed;
      if (parsed.message) return String(parsed.message);
      if (parsed.data?.reply) return String(parsed.data.reply);
      if (parsed.data?.message) return String(parsed.data.message);
      if (parsed.data && typeof parsed.data === "string") return parsed.data;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return textPart.text;
    }
  }

  async send(operation: string, params: Record<string, unknown> = {}, contextId?: string): Promise<A2ATask> {
    const rpcParams: Record<string, unknown> = {
      message: {
        role: "user",
        parts: [{ kind: "text", text: JSON.stringify({ operation, params }) }],
      },
    };
    if (contextId) rpcParams.contextId = contextId;

    const response = await this.rpc("message/send", rpcParams);

    if (response.error) {
      throw new Error(`A2A error [${response.error.code}]: ${response.error.message}`);
    }
    if (!response.result) {
      throw new Error("Empty response from A2A endpoint");
    }

    return response.result;
  }

  async getTask(taskId: string): Promise<A2ATask> {
    const response = await this.rpc("tasks/get", { id: taskId });

    if (response.error) {
      throw new Error(`A2A error [${response.error.code}]: ${response.error.message}`);
    }
    return response.result!;
  }

  async cancelTask(taskId: string): Promise<A2ATask> {
    const response = await this.rpc("tasks/cancel", { id: taskId });

    if (response.error) {
      throw new Error(`A2A error [${response.error.code}]: ${response.error.message}`);
    }
    return response.result!;
  }

  extractData(task: A2ATask): unknown {
    if (!task.artifacts?.length) return null;
    const textPart = task.artifacts[0].parts.find((p) => p.kind === "text");
    if (!textPart?.text) return null;
    try {
      return JSON.parse(textPart.text);
    } catch {
      return textPart.text;
    }
  }
}
