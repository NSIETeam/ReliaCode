# ReliaCode

ReliaCode (可靠码) is an operator-managed traceability application for serialized pet-food packs.
It records the lifecycle from individual bag to carton, distributor, and retail store.

## Scope

- Assign a unique identity to each finished bag.
- Bind bags to a uniquely identified carton at packing time.
- Record shipping, receiving, unpacking, repacking, returns, and recall events.
- Let ReliaCode configure auditable incentives for verified distributor and store
  activities.
- Publish GS1 EPCIS 2.0 events to an OpenEPCIS repository.

ReliaCode is the business and scan-workflow layer. OpenEPCIS is the standards-based
traceability event repository; it is an external dependency, not vendored source code.

## Architecture

```text
Scan stations / mobile app -> ReliaCode API -> OpenEPCIS -> trace and recall views
                                      |
                                      +-> ERP/WMS adapter
```

See [the architecture note](docs/architecture.md) and
[ADR-0001](docs/adr/0001-openepcis-as-traceability-core.md).
The initial incentive design is documented in
[scan-incentive.md](docs/domain/scan-incentive.md).
For industry review, see the Chinese [usage and reward model](docs/zh-CN/可靠码使用与奖励模式-行业评审稿.md).

## First acceptance scenario

1. Commission 100 serialized bags in one production lot.
2. Pack ten bags into each uniquely identified carton.
3. Ship and receive cartons at a distributor, then at a store.
4. Unpack, repack, sell, and return bags.
5. Trace from an ingredient/production lot to every affected bag and its latest custodian.

## License and notices

ReliaCode-owned files are licensed under [Apache-2.0](LICENSE). OpenEPCIS is a
separate Apache-2.0 dependency. See [third-party notices](THIRD_PARTY_NOTICES.md).

This repository is intentionally an initial scaffold: it contains no production
credentials, customer data, or copied OpenEPCIS source.

## Runnable MVP

The operations prototype is in [apps/scan-web](apps/scan-web). Run `npm run dev`
from that folder and open `http://localhost:4173` to demonstrate verified receipt
scanning, incentive campaigns, ledger entries, and risk review.
