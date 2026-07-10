# Azure Managed Redis Monitoring Notes

This folder holds Azure Managed Redis monitoring artifacts used as production-readiness evidence for the KAIF boundary path.

Current artifact:

- [charts/AzureManagedRedis-2026-07-09.json](charts/AzureManagedRedis-2026-07-09.json)

## What this dashboard covers

The exported Grafana dashboard is a useful infrastructure view for Azure Managed Redis Enterprise. It currently covers:

- CPU usage
- memory usage
- connected clients
- total operations
- cache read throughput
- cache write throughput
- read/write comparison
- hit/miss comparison
- geo replication health

These panels are enough to answer:

- is the Redis service up and responsive
- is Redis under CPU or memory pressure
- are client connections dropping unexpectedly
- is the store still serving read/write traffic during KAIF activity
- is geo replication healthy, if enabled

## What this dashboard does not prove

This dashboard does not, by itself, prove KAIF boundary correctness.

It does not show:

- whether `BOUNDARY_PERMIT` events are being written
- whether `BOUNDARY_RECEIPT` events are being written
- whether revocation keys persist across reconnects
- whether KAIF is reconnecting cleanly after transient Redis faults
- whether Foundry-bound authorize calls are succeeding or failing
- whether `request_id`, `decision_id`, and `run_id` are surviving into receipts

So this dashboard should be treated as:

- Azure Redis infrastructure health evidence

not as:

- full KAIF boundary attestation evidence

## Minimum Azure charts to keep

These should remain in the Azure/Grafana dashboard:

1. CPU usage
2. memory usage
3. connected clients
4. total operations
5. cache read
6. cache write
7. hit/miss
8. geo replication healthy

## Additional Azure-side data points to collect

For KAIF operations, collect these Azure-side data points on every serious smoke, rehearsal, or incident review:

1. CPU max during the run window
2. memory max during the run window
3. connected clients min/max during the run window
4. total operations during the run window
5. read/write deltas during the run window
6. hit/miss ratio during the run window
7. any geo replication unhealthy interval during the run window

Recommended evidence window:

- start: 5 minutes before the KAIF smoke or conformance run
- end: 10 minutes after completion

## KAIF-specific charts still needed

These should be added in a separate KAIF application dashboard, or exported through Grafana if you later surface them there.

### Boundary authorization

1. boundary authorize request count
2. boundary permit count
3. boundary deny count
4. boundary receipt count
5. boundary authorize error count

### Foundry execution

1. Foundry success count
2. Foundry rejected/error count
3. Foundry latency P50
4. Foundry latency P95
5. Foundry latency P99
6. provider request id presence rate

### Redis continuity

1. audit append success count
2. audit append failure count
3. audit chain length growth
4. revocation key write count
5. revocation lookup failure count
6. reconnect count

### Correlation and evidence

1. receipt generation count
2. receipt failure count
3. receipts missing `provider_request_id`
4. receipts missing `output_hash`
5. receipts missing `request_id` / `run_id` / `decision_id`

## Minimum fields to capture per test run

For each smoke or conformance run, retain:

1. test run id
2. start/end timestamps
3. Redis dashboard screenshot or export
4. KAIF request id
5. KAIF decision id
6. token jti
7. delegation id
8. provider request id
9. boundary decision
10. receipt result status
11. receipt latency

This aligns with the KAIF boundary contract, which treats `request_id`, `run_id`, `decision_id`, `delegation_id`, `token_jti`, and returned receipt fields as the durable evidence set.

## Recommended next dashboard additions

If you extend the Grafana export later, add panels for:

1. Redis client reconnect events
2. failed Redis operations
3. evictions, if the metric is available for this SKU/profile
4. network saturation or throttling indicators, if available
5. per-run operation bursts during KAIF smoke windows

## Operational interpretation

Use both layers together:

- Azure Managed Redis dashboard answers: "Was the store healthy?"
- KAIF application dashboard answers: "Did the boundary and evidence path behave correctly?"

You need both to claim production readiness.
