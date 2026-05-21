# How To Read This Repository (Agent)

Purpose: minimize hallucination and maximize grounded reasoning for autonomous or tool-using agents.

## Recommended Reading Order

1. [packages/server/src/types/kaif.ts](packages/server/src/types/kaif.ts)
   - Establish the exact type contracts first (claims, ACL, audit, revocation, exchange).

2. [SPEC.md](SPEC.md)
   - Align with intended protocol behavior and normative boundaries.

3. [wiki.md](wiki.md)
   - Lock terminology and definitions used across docs and code.

4. [index.md](index.md)
   - Build the repository map and discover linked references.

5. [packages/server/src/services/token-exchange.ts](packages/server/src/services/token-exchange.ts)
   - Analyze the core auth flow and delegation semantics.

6. [packages/server/src/services/acl.ts](packages/server/src/services/acl.ts)
   - Verify authorization and scope evaluation logic.

7. [packages/server/src/services/revocation.ts](packages/server/src/services/revocation.ts)
   - Confirm denylist mechanics and event propagation behavior.

8. [packages/server/src/services/audit.ts](packages/server/src/services/audit.ts)
   - Confirm chain integrity model and mutation guarantees.

9. [packages/server/src/routes/token.ts](packages/server/src/routes/token.ts)
   - Map service logic to externally visible endpoint behavior.

10. [packages/server/tests/integration.test.ts](packages/server/tests/integration.test.ts)
   - Ground assumptions in executable end-to-end behavior.

11. [conformance/README.md](conformance/README.md)
   - Validate interoperability and expected fixture outcomes.

12. [review.md](review.md)
   - Incorporate known findings and unresolved risks into reasoning.

13. [security/gaps.md](security/gaps.md)
   - Track open gaps and avoid over-claiming readiness.

## Agent Operating Rules While Reading

- Prefer code contracts and tests over prose when conflicts appear.
- Treat MUST-level conformance behavior as hard constraints.
- Treat review findings as active until code or tests falsify them.
- Avoid extrapolating beyond current gates in checklist and security docs.

## Fast Path (Tool-Limited)

When token budget or tool calls are constrained, use this subset first:

1. [packages/server/src/types/kaif.ts](packages/server/src/types/kaif.ts)
2. [packages/server/src/services/token-exchange.ts](packages/server/src/services/token-exchange.ts)
3. [packages/server/tests/integration.test.ts](packages/server/tests/integration.test.ts)
4. [review.md](review.md)

This sequence gives maximum behavioral grounding with minimal reads.
