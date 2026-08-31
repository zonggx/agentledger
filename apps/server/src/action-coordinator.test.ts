import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionCapabilityRegistry, FailureInjector } from "./action-capabilities.js";
import { ActionCoordinator, SimulatedWorkerCrash } from "./action-coordinator.js";
import { MockBookingProvider } from "./mock-booking-provider.js";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeHarness(root?: string) {
  const directory = root ?? (await mkdtemp(path.join(tmpdir(), "action-ledger-test-")));
  if (!root) temporaryDirectories.push(directory);
  const store = new JsonStore(path.join(directory, "launchpad.json"));
  const provider = new MockBookingProvider(path.join(directory, "provider.json"));
  await store.initialize();
  await provider.initialize();
  if (store.snapshot().runs.length === 0) {
    const timestamp = new Date().toISOString();
    await store.mutate((database) => {
      database.runs.push({
        id: "run-1",
        agentId: "agent-1",
        status: "running",
        prompt: "create booking",
        output: null,
        error: null,
        usage: null,
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
      });
    });
  }
  const capabilities = new ActionCapabilityRegistry();
  const failures = new FailureInjector();
  const coordinator = new ActionCoordinator(store, provider, capabilities, failures);
  const token = capabilities.issue("agent-1", "run-1", 60_000);
  return { directory, store, provider, coordinator, failures, token };
}

const booking = {
  operationId: "trip-001",
  travelerAlias: "demo-alice",
  route: "SIN-NRT",
  date: "2026-09-15",
};

describe("Agent Action Ledger", () => {
  it("returns a durable result without creating a duplicate booking", async () => {
    const harness = await makeHarness();
    const first = await harness.coordinator.executeBooking(harness.token, booking);
    const replay = await harness.coordinator.executeBooking(harness.token, booking);

    expect(replay.replayed).toBe(true);
    expect(replay.result.bookingId).toBe(first.result.bookingId);
    expect(harness.provider.count()).toBe(1);
    expect(harness.store.snapshot().actions).toHaveLength(1);
  });

  it("serializes concurrent duplicate requests", async () => {
    const harness = await makeHarness();
    const [left, right] = await Promise.all([
      harness.coordinator.executeBooking(harness.token, booking),
      harness.coordinator.executeBooking(harness.token, booking),
    ]);

    expect(left.result.bookingId).toBe(right.result.bookingId);
    expect(harness.provider.count()).toBe(1);
  });

  it("rejects an operation ID reused with different input", async () => {
    const harness = await makeHarness();
    await harness.coordinator.executeBooking(harness.token, booking);

    await expect(
      harness.coordinator.executeBooking(harness.token, {
        ...booking,
        route: "SIN-LHR",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(harness.provider.count()).toBe(1);
  });

  it("recovers a provider success after the worker crashes", async () => {
    const harness = await makeHarness();
    harness.failures.arm("agent-1");

    await expect(
      harness.coordinator.executeBooking(harness.token, booking),
    ).rejects.toBeInstanceOf(SimulatedWorkerCrash);
    expect(harness.provider.count()).toBe(1);
    expect(harness.store.snapshot().actions[0]?.status).toBe("executing");

    const recovered = await harness.coordinator.executeBooking(harness.token, booking);
    expect(recovered.recovered).toBe(true);
    expect(recovered.action.status).toBe("succeeded");
    expect(harness.provider.count()).toBe(1);
    expect(harness.store.snapshot().actionEvents.map((event) => event.type)).toContain(
      "action.recovered",
    );
  });

  it("reconciles an unfinished action during startup", async () => {
    const first = await makeHarness();
    first.failures.arm("agent-1");
    await expect(
      first.coordinator.executeBooking(first.token, booking),
    ).rejects.toBeInstanceOf(SimulatedWorkerCrash);

    const restarted = await makeHarness(first.directory);
    await restarted.coordinator.initialize();

    expect(restarted.store.snapshot().actions[0]?.status).toBe("succeeded");
    expect(restarted.provider.count()).toBe(1);
  });

  it("denies tool calls without an active run capability", async () => {
    const harness = await makeHarness();
    await expect(
      harness.coordinator.executeBooking("not-a-capability", booking),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(harness.provider.count()).toBe(0);
  });
});
