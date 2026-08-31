export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type ToolActionStatus =
  | "prepared"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface BookingInputSummary {
  travelerAlias: string;
  route: string;
  date: string;
}

export interface BookingResultSummary {
  bookingId: string;
  route: string;
  date: string;
}

export interface ToolAction {
  id: string;
  agentId: string;
  runIds: string[];
  tool: "booking.create";
  operationId: string;
  inputHash: string;
  inputSummary: BookingInputSummary;
  idempotencyKey: string;
  status: ToolActionStatus;
  attemptCount: number;
  providerReference: string | null;
  resultSummary: BookingResultSummary | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ActionEventType =
  | "action.prepared"
  | "action.executing"
  | "provider.accepted"
  | "worker.crashed"
  | "action.reconciling"
  | "action.recovered"
  | "action.succeeded"
  | "action.failed"
  | "action.outcome_unknown"
  | "action.replayed";

export interface ActionEvent {
  id: string;
  actionId: string;
  agentId: string;
  runId: string;
  type: ActionEventType;
  detail: string;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  actions: ToolAction[];
  actionEvents: ActionEvent[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  runId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  actionGatewayUrl: string;
  actionCapability: string;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
