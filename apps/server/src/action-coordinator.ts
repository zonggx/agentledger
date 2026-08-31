import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  ActionEvent,
  ActionEventType,
  BookingInputSummary,
  ToolAction,
} from "./types.js";
import {
  ActionCapabilityRegistry,
  FailureInjector,
  type ActionCapabilityContext,
} from "./action-capabilities.js";
import { MockBookingProvider, type MockBooking } from "./mock-booking-provider.js";

const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export interface CreateBookingRequest extends BookingInputSummary {
  operationId: string;
}

export interface ActionExecutionResult {
  action: ToolAction;
  result: NonNullable<ToolAction["resultSummary"]>;
  replayed: boolean;
  recovered: boolean;
}

export class SimulatedWorkerCrash extends Error {
  constructor(public readonly actionId: string) {
    super("Transactional worker stopped after provider acknowledgement");
    this.name = "SimulatedWorkerCrash";
  }
}

export class ActionCoordinator {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: JsonStore,
    private readonly provider: MockBookingProvider,
    readonly capabilities: ActionCapabilityRegistry,
    readonly failures: FailureInjector,
  ) {}

  async initialize(): Promise<void> {
    const unfinished = this.store
      .snapshot()
      .actions.filter((action) => action.status === "executing");
    for (const action of unfinished) {
      await this.reconcile(action.id, action.runIds.at(-1) ?? action.runIds[0] ?? "startup");
    }
  }

  listRunEvidence(runId: string): { actions: ToolAction[]; events: ActionEvent[] } {
    const database = this.store.snapshot();
    const actions = database.actions.filter((action) => action.runIds.includes(runId));
    const actionIds = new Set(actions.map((action) => action.id));
    return {
      actions: actions.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      events: database.actionEvents
        .filter((event) => actionIds.has(event.actionId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
  }

  listAgentBookings(agentId: string): Array<{
    bookingId: string;
    route: string;
    date: string;
    travelerAlias: string;
    createdAt: string;
  }> {
    return this.provider.listForAgent(agentId).map((booking) => ({
      bookingId: booking.id,
      route: booking.route,
      date: booking.date,
      travelerAlias: booking.travelerAlias,
      createdAt: booking.createdAt,
    }));
  }

  async executeBooking(token: string, request: CreateBookingRequest): Promise<ActionExecutionResult> {
    const context = this.authorize(token);
    const normalized = normalizeBooking(request);
    const inputHash = hash(JSON.stringify(normalized.input));
    const lockKey = context.agentId + ":booking.create:" + normalized.operationId;
    return this.withLock(lockKey, () =>
      this.executeLocked(context, normalized.operationId, normalized.input, inputHash),
    );
  }

  async reconcile(actionId: string, runId?: string): Promise<ToolAction> {
    const action = this.store.snapshot().actions.find((item) => item.id === actionId);
    if (!action) throw new HttpError(404, "Action not found");
    const effectiveRunId = runId ?? action.runIds.at(-1) ?? "manual";
    await this.appendEvent(action, effectiveRunId, "action.reconciling", "Checking provider state");
    const booking = this.provider.findByIdempotencyKey(action.idempotencyKey);
    if (!booking) {
      return this.store.mutate((database) => {
        const stored = database.actions.find((item) => item.id === action.id);
        if (!stored) throw new HttpError(404, "Action not found");
        stored.status = "prepared";
        stored.errorCode = null;
        stored.updatedAt = now();
        return structuredClone(stored);
      });
    }
    return this.complete(action.id, effectiveRunId, booking, true);
  }

  private authorize(token: string): ActionCapabilityContext {
    const context = this.capabilities.resolve(token);
    if (!context || !context.allowedTools.includes("booking.create")) {
      throw new HttpError(401, "Valid run-scoped action capability required");
    }
    const run = this.store.snapshot().runs.find((item) => item.id === context.runId);
    if (!run || run.agentId !== context.agentId || run.status !== "running") {
      throw new HttpError(403, "Action capability is not attached to an active Run");
    }
    return context;
  }

  private async executeLocked(
    context: ActionCapabilityContext,
    operationId: string,
    input: BookingInputSummary,
    inputHash: string,
  ): Promise<ActionExecutionResult> {
    let action = await this.ensureAction(context, operationId, input, inputHash);
    if (action.status === "succeeded" && action.resultSummary) {
      action = await this.store.mutate((database) => {
        const stored = database.actions.find((item) => item.id === action.id)!;
        stored.attemptCount += 1;
        stored.updatedAt = now();
        database.actionEvents.push(
          eventFor(stored, context.runId, "action.replayed", "Returned durable result without repeating provider action"),
        );
        return structuredClone(stored);
      });
      return { action, result: action.resultSummary!, replayed: true, recovered: false };
    }

    if (action.status === "executing" || action.status === "outcome_unknown") {
      await this.appendEvent(action, context.runId, "action.reconciling", "Retry checked provider before execution");
      const existing = this.provider.findByIdempotencyKey(action.idempotencyKey);
      if (existing) {
        action = await this.complete(action.id, context.runId, existing, true);
        return { action, result: action.resultSummary!, replayed: false, recovered: true };
      }
    }

    action = await this.store.mutate((database) => {
      const stored = database.actions.find((item) => item.id === action.id)!;
      stored.status = "executing";
      stored.attemptCount += 1;
      stored.errorCode = null;
      stored.updatedAt = now();
      database.actionEvents.push(
        eventFor(stored, context.runId, "action.executing", "Provider call started with stable idempotency key"),
      );
      return structuredClone(stored);
    });

    const injectCrash = this.failures.consume(context.agentId);
    let booking: MockBooking;
    try {
      booking = await this.provider.create(
        context.agentId,
        input,
        action.idempotencyKey,
        action.inputHash,
      );
    } catch {
      await this.markUnknown(action.id, context.runId, "PROVIDER_OUTCOME_UNKNOWN");
      throw new HttpError(502, "Booking provider outcome could not be determined");
    }

    if (injectCrash) {
      await this.appendEvent(
        action,
        context.runId,
        "worker.crashed",
        "Controlled worker crash after provider acknowledgement",
      );
      throw new SimulatedWorkerCrash(action.id);
    }

    action = await this.complete(action.id, context.runId, booking, false);
    return { action, result: action.resultSummary!, replayed: false, recovered: false };
  }

  private async ensureAction(
    context: ActionCapabilityContext,
    operationId: string,
    input: BookingInputSummary,
    inputHash: string,
  ): Promise<ToolAction> {
    return this.store.mutate((database) => {
      const existing = database.actions.find(
        (action) =>
          action.agentId === context.agentId &&
          action.tool === "booking.create" &&
          action.operationId === operationId,
      );
      if (existing) {
        if (existing.inputHash !== inputHash) {
          throw new HttpError(
            409,
            "Operation ID already exists with different booking input",
          );
        }
        if (!existing.runIds.includes(context.runId)) existing.runIds.push(context.runId);
        existing.updatedAt = now();
        return structuredClone(existing);
      }
      const timestamp = now();
      const action: ToolAction = {
        id: randomUUID(),
        agentId: context.agentId,
        runIds: [context.runId],
        tool: "booking.create",
        operationId,
        inputHash,
        inputSummary: input,
        idempotencyKey: hash(
          context.agentId + "\0booking.create\0" + operationId + "\0" + inputHash,
        ),
        status: "prepared",
        attemptCount: 0,
        providerReference: null,
        resultSummary: null,
        errorCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
      };
      database.actions.push(action);
      database.actionEvents.push(
        eventFor(action, context.runId, "action.prepared", "Action recorded before provider execution"),
      );
      return structuredClone(action);
    });
  }

  private async complete(
    actionId: string,
    runId: string,
    booking: MockBooking,
    recovered: boolean,
  ): Promise<ToolAction> {
    return this.store.mutate((database) => {
      const stored = database.actions.find((item) => item.id === actionId);
      if (!stored) throw new HttpError(404, "Action not found");
      const timestamp = now();
      stored.status = "succeeded";
      stored.providerReference = booking.id;
      stored.resultSummary = {
        bookingId: booking.id,
        route: booking.route,
        date: booking.date,
      };
      stored.errorCode = null;
      stored.updatedAt = timestamp;
      stored.completedAt = timestamp;
      database.actionEvents.push(
        eventFor(stored, runId, "provider.accepted", "Provider booking reference recorded"),
      );
      if (recovered) {
        database.actionEvents.push(
          eventFor(stored, runId, "action.recovered", "Existing provider booking recovered without duplication"),
        );
      }
      database.actionEvents.push(
        eventFor(stored, runId, "action.succeeded", "Durable booking result available"),
      );
      return structuredClone(stored);
    });
  }

  private async markUnknown(actionId: string, runId: string, code: string): Promise<void> {
    await this.store.mutate((database) => {
      const stored = database.actions.find((item) => item.id === actionId);
      if (!stored) return;
      stored.status = "outcome_unknown";
      stored.errorCode = code;
      stored.updatedAt = now();
      database.actionEvents.push(
        eventFor(stored, runId, "action.outcome_unknown", "Provider outcome requires reconciliation"),
      );
    });
  }

  private async appendEvent(
    action: ToolAction,
    runId: string,
    type: ActionEventType,
    detail: string,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const stored = database.actions.find((item) => item.id === action.id);
      if (stored) database.actionEvents.push(eventFor(stored, runId, type, detail));
    });
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

function normalizeBooking(request: CreateBookingRequest): {
  operationId: string;
  input: BookingInputSummary;
} {
  return {
    operationId: request.operationId.trim(),
    input: {
      travelerAlias: request.travelerAlias.trim().toLowerCase(),
      route: request.route.trim().toUpperCase(),
      date: request.date,
    },
  };
}

function eventFor(
  action: ToolAction,
  runId: string,
  type: ActionEventType,
  detail: string,
): ActionEvent {
  return {
    id: randomUUID(),
    actionId: action.id,
    agentId: action.agentId,
    runId,
    type,
    detail,
    createdAt: now(),
  };
}
