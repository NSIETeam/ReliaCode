# ADR 0002: Keep incentive ledger separate from trace events

## Status

Accepted

## Context

Brands need to motivate channels and stores to perform real receiving and
inventory activities. A direct "scan equals payment" design is easy to game,
and editing a trace event when a reward is disputed would corrupt the audit
trail.

## Decision

Persist traceability facts as immutable events. Evaluate reward claims
asynchronously after validation and risk checks. Use a separate append-only
ledger for accruals and reversals, with versioned campaign rules and idempotent
claim keys.

## Consequences

- Traceability remains reliable even when an incentive is refused or reversed.
- Rewards can be audited, capped, frozen, disputed, and settled independently.
- Initial deployment can use points or accrued balances before integrating a
  regulated payment provider.
