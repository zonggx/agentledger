export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export type ToolActionStatus =
  | "prepared"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

export interface ToolAction {
  id: string;
  agentId: string;
  runIds: string[];
  tool: "booking.create";
  operationId: string;
  inputSummary: {
    travelerAlias: string;
    route: string;
    date: string;
  };
  status: ToolActionStatus;
  attemptCount: number;
  resultSummary: {
    bookingId: string;
    route: string;
    date: string;
  } | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ActionEvent {
  id: string;
  actionId: string;
  runId: string;
  type: string;
  detail: string;
  createdAt: string;
}

export interface BookingEvidence {
  bookingId: string;
  route: string;
  date: string;
  travelerAlias: string;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  actionLedgerEnabled: boolean;
  failureInjectionEnabled: boolean;
}
