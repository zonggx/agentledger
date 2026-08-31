import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BookingInputSummary } from "./types.js";

export interface MockBooking extends BookingInputSummary {
  id: string;
  agentId: string;
  idempotencyKey: string;
  inputHash: string;
  createdAt: string;
}

interface ProviderDatabase {
  version: 1;
  bookings: MockBooking[];
}

const emptyDatabase = (): ProviderDatabase => ({ version: 1, bookings: [] });

export class MockBookingProvider {
  private data: ProviderDatabase = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as ProviderDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.bookings)) {
        throw new Error("Unsupported mock booking provider format");
      }
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist(this.data);
    }
  }

  async create(
    agentId: string,
    input: BookingInputSummary,
    idempotencyKey: string,
    inputHash: string,
  ): Promise<MockBooking> {
    return this.mutate((database) => {
      const existing = database.bookings.find(
        (booking) => booking.idempotencyKey === idempotencyKey,
      );
      if (existing) {
        if (existing.inputHash !== inputHash) {
          throw new Error("Provider idempotency key was reused with different input");
        }
        return structuredClone(existing);
      }
      const booking: MockBooking = {
        id: randomUUID(),
        agentId,
        idempotencyKey,
        inputHash,
        ...input,
        createdAt: new Date().toISOString(),
      };
      database.bookings.push(booking);
      return structuredClone(booking);
    });
  }

  findByIdempotencyKey(idempotencyKey: string): MockBooking | null {
    const booking = this.data.bookings.find(
      (item) => item.idempotencyKey === idempotencyKey,
    );
    return booking ? structuredClone(booking) : null;
  }

  listForAgent(agentId: string): MockBooking[] {
    return this.data.bookings
      .filter((booking) => booking.agentId === agentId)
      .map((booking) => structuredClone(booking));
  }

  count(): number {
    return this.data.bookings.length;
  }

  private async mutate<T>(mutation: (database: ProviderDatabase) => T): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(database: ProviderDatabase): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(database, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
