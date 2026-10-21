# ADR 0001: Use OpenEPCIS as the traceability event core

## Status

Accepted

## Context

ReliaCode needs a portable, auditable model for serialized bags, cartons, and
chain-of-custody events. A bespoke mutable carton-contents table would not
preserve unpacking and repacking history or interoperate with trading partners.

## Decision

Use the GS1 EPCIS 2.0 event model and integrate an external OpenEPCIS Community
Edition repository for capture and query. ReliaCode will own workflow-specific
APIs and emit validated, idempotent EPCIS events.

## Consequences

- ReliaCode remains independently named and separately deployable.
- OpenEPCIS upgrades are version-pinned and tested through the integration boundary.
- We preserve Apache-2.0 notices if any upstream material is later incorporated.
