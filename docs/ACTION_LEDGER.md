# Agent Action Ledger

## Problem

An Agent may call a side-effecting tool successfully and then lose the result
when its worker or Runtime stops. Blindly repeating the tool can create a second
payment, booking, email, or deployment.

This POC proves a narrower guarantee using one mock booking adapter: repeated
gateway attempts with the same Agent and operation ID produce one provider
booking when the input is unchanged.

## Boundary and data flow

1. `AgentService` marks a Run active and issues a short-lived booking
   capability.
2. Codex calls `.launchpad/tools/create-booking.mjs` from its workspace.
3. The internal Fastify route validates the capability and booking schema.
4. `ActionCoordinator` persists `prepared`, then `executing`.
5. `MockBookingProvider` atomically creates or returns the booking for the
   server-generated idempotency key.
6. The coordinator persists the result or reconciles it after an ambiguous
   interruption.
7. The browser polls Run evidence and renders only persisted events.

The tool script is convenience UX, not the security boundary. The gateway
validates the run capability, path-independent schema, active Run, operation
identity, and input hash.

## Controlled recovery demo

Configure:

```dotenv
ENABLE_FAILURE_INJECTION=true
```

In the browser:

1. Create or select a ready Agent.
2. Select **Arm booking crash**.
3. Ask the Agent to create a booking using a stable operation ID and retry once
   on failure.
4. Observe `prepared`, `executing`, and the controlled worker failure.
5. Observe the retry reconcile the provider record and reach `succeeded`.
6. Verify the panel still reports one provider booking.

Manual reconciliation remains available when an action is `executing` or
`outcome_unknown`.

## Automated proof

`npm test` verifies:

- sequential replay returns the original booking;
- concurrent requests create one provider record;
- changed input under one operation ID is rejected;
- retry after the critical crash window recovers the original result;
- startup reconciliation repairs unfinished actions; and
- calls without a valid active-Run capability are denied.

Run the complete repository check with:

```bash
npm run check
```

## Guarantees and limitations

The POC guarantees at-most-one provider booking for the implemented adapter
because that provider accepts stable idempotency keys and supports lookup. It
does not guarantee exactly-once execution for arbitrary providers or shell
commands. Real integrations must either retry the same provider key, query the
provider, or surface an ambiguous outcome for human resolution.

Compensation is intentionally excluded: many real effects, such as sending an
email, cannot be rolled back. The JSON stores and in-memory operation locks are
single-process and not suitable for multi-node production deployment.

Deleting an Agent removes its local ledger and event evidence with the rest of
its control-plane metadata. The independent mock provider record is retained,
mirroring an external side effect that Agent deletion cannot silently undo.
