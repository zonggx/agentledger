import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface ActionCapabilityContext {
  agentId: string;
  runId: string;
  allowedTools: readonly ["booking.create"];
}

interface CapabilityRecord extends ActionCapabilityContext {
  tokenHash: Buffer;
  expiresAt: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export class ActionCapabilityRegistry {
  private readonly records = new Map<string, CapabilityRecord>();

  issue(agentId: string, runId: string, ttlMs: number): string {
    const token = randomBytes(32).toString("base64url");
    this.records.set(runId, {
      agentId,
      runId,
      allowedTools: ["booking.create"],
      tokenHash: digest(token),
      expiresAt: Date.now() + ttlMs,
    });
    return token;
  }

  resolve(token: string): ActionCapabilityContext | null {
    if (!token) return null;
    const candidate = digest(token);
    for (const record of this.records.values()) {
      if (record.expiresAt <= Date.now()) {
        this.records.delete(record.runId);
        continue;
      }
      if (
        candidate.length === record.tokenHash.length &&
        timingSafeEqual(candidate, record.tokenHash)
      ) {
        return {
          agentId: record.agentId,
          runId: record.runId,
          allowedTools: record.allowedTools,
        };
      }
    }
    return null;
  }

  revoke(runId: string): void {
    this.records.delete(runId);
  }
}

export class FailureInjector {
  private readonly armedAgents = new Set<string>();

  arm(agentId: string): void {
    this.armedAgents.add(agentId);
  }

  consume(agentId: string): boolean {
    return this.armedAgents.delete(agentId);
  }
}
