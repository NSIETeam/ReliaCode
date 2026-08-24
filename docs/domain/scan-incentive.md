# Scan incentive domain

## Goal

Allow a brand to reward approved distributors and stores for completing useful,
verified traceability activities. The incentive is for a completed business
process, not for opening a QR code.

## Initial MVP

The first release supports only approved distributor and store organizations.
It rewards the beneficiary for a first, verified receipt that matches an
expected shipment. The reward is held for seven days and settled monthly. Use
points or an internal accrued balance first; do not implement direct cash
payments in the MVP.

## Separation of facts and rewards

1. A client submits a scan with an idempotency key.
2. ReliaCode validates the user, device, organization, expected shipment,
   object state, carton membership, and risk checks.
3. It appends a `TraceEvent` and publishes the corresponding EPCIS event.
4. The incentive service evaluates the frozen version of the active rule.
5. It creates a `RewardClaim`, then an append-only `RewardLedgerEntry` only
   after approval.

A rejected, reversed, or unpaid reward never changes the traceability record.

## Rewardable activities

| Activity | Default beneficiary | Verification requirement |
| --- | --- | --- |
| Distributor receipt | Receiving distributor | Shipment, recipient, carton state, and first receipt agree |
| Store receipt | Receiving store | Shipment, recipient, carton state, and first receipt agree |
| Store shelf verification | Store | Optional later phase; valid active inventory and campaign rule |
| Sale verification | Store | Optional later phase; validated POS/ERP evidence |

Ordinary consumer queries, repeated scans, and scans before shipment are never
rewardable in the MVP.

## Carton and bag counting rules

- A sealed carton receipt earns at the carton level once. Its children must not
  earn an additional bag-level receipt reward under the same campaign.
- A bag removed from a carton is eligible only if it has not already been paid
  through the parent carton and the rule explicitly permits a later activity.
- Repacking requires the source `DELETE` and destination `ADD` aggregation
  events before it can be evaluated.
- Returns and destroyed stock create reversing entries when a rule requires
  clawback.

## Core records

| Record | Purpose |
| --- | --- |
| `Campaign` | Brand-owned budget, date range, eligible products and organizations |
| `RewardRule` | Versioned trigger, reward amount, caps, verification and reversal rules |
| `TraceEvent` | Immutable verified scan or workflow fact |
| `RewardClaim` | Evaluation of one potential reward; pending, approved, rejected, accrued, settled, or reversed |
| `RewardLedgerEntry` | Immutable positive or reversing balance entry in the smallest unit of the reward currency/points |
| `RiskSignal` / `RiskDecision` | Evidence, score, and automated or manual disposition |
| `SettlementBatch` | Locked monthly set of approved claims |

Use integer smallest units for monetary values. A claim should be unique at
least by `campaignId + activityType + objectId + beneficiaryId`; a campaign can
tighten this to a global first-valid-event rule.

## Anti-fraud controls

- Require verified organization, assigned user role, and registered device.
- Validate event time server-side; require an idempotency key and use a short
  nonce/challenge for higher-value activities.
- Enforce scan-rate, daily and monthly campaign caps, cooldowns, and one active
  carton parent per bag.
- Cross-check shipment/ASN, order, ERP/WMS inventory, source and destination,
  and EPCIS event order.
- Flag repeated codes, pre-shipment scans, cross-region scans, implausible scan
  speed, many accounts on one device, and one account on many devices.
- Accept offline scans only as `pending`; award nothing until online validation.
- Hold high-risk claims for review and retain an audit trail for every decision.

GPS and a QR code are risk signals, not conclusive proof of a real handover.

## Roles and separation of duties

- Brand administrator: configures campaigns and rules, but cannot alter ledger entries.
- Channel/store operator: sees only its authorized organization and outlets.
- Risk operator: reviews flagged claims and cannot settle payments.
- Finance operator: settles approved batches and cannot approve its own adjustments.

Campaign publication, manual approval, adjustment, and settlement should have
separate permissions and, above a threshold, a second approver.

## Compliance boundary

Before any cash, red-packet, or bank transfer rollout in China, obtain legal,
tax, privacy, and payment-provider review. In particular, define the recipient
(preferably the contracted organization for the MVP), data-use notice and
retention period, tax documentation, reversal and dispute terms, and whether a
licensed payment provider is required. Do not operate a self-managed funds pool.
