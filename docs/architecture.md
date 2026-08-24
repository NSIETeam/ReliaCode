# Architecture

## Responsibility split

ReliaCode owns the operator-facing workflow: authentication, organizations,
scan validation, carton contents, business-document references, and exception
handling. OpenEPCIS owns standards-compliant persistence and querying of EPCIS
events.

The incentive service consumes verified ReliaCode workflow events. It never
changes a traceability event or treats an unverified QR scan as a rewardable
activity. See [the incentive domain design](domain/scan-incentive.md).

## Object identities

| Object | Identity | Purpose |
| --- | --- | --- |
| Finished bag | SGTIN or brand-issued unique serial | Instance-level consumer pack identity |
| Production lot | Lot identifier | Batch, quality, date, and recall scope |
| Carton | SSCC or unique logistics-unit ID | Parent for bag aggregation |
| Location | GLN or controlled location ID | Factory, warehouse, distributor, or store |

## Required events

- `ObjectEvent`: commission, ship, receive, sell, return, destroy.
- `AggregationEvent` with `ADD`: pack bags into a carton.
- `AggregationEvent` with `DELETE`: unpack or remove bags from a carton.
- `TransactionEvent`: associate objects with production, shipping, and receiving documents.
- `TransformationEvent`: link source material lots to produced finished lots.

Every event must be append-only and include an event time, read point or
business location, acting organization, and an idempotency key.

## Workflow rule

A bag can belong to at most one active carton. Shipping a sealed carton moves
its known contents logically; receiving normally scans the carton once and
performs bag-level verification only when an exception or inspection requires it.

## Incentive rule

An activity can earn a reward only after server-side verification of the actor,
organization, expected shipment, object state, active carton membership, and
campaign rule. A reward entry is append-only and can only be cancelled using a
separate reversing entry.
