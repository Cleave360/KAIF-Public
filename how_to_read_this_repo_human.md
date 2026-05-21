# How To Read This Repository (Human)

Purpose: help a human reviewer or contributor understand KAIF quickly, then go deeper in a structured sequence.

## Recommended Reading Order

1. [index.md](index.md)
   - Start with the global map, implementation status, and cross-links.

2. [README.md](README.md)
   - Get project framing, intended outcomes, and high-level usage.

3. [QUICKSTART.md](QUICKSTART.md)
   - Learn the fastest path to running and validating the stack.

4. [wiki.md](wiki.md)
   - Normalize vocabulary, claims, and naming before reading deeper specs.

5. [SPEC.md](SPEC.md)
   - Review protocol behavior, trust model, and normative requirements.

6. [CODEBASE_TOUR.md](CODEBASE_TOUR.md)
   - Connect architecture concepts to concrete implementation layout.

7. [SECURITY.md](SECURITY.md)
   - Understand threat posture, disclosure policy, and deployment security gates.

8. [KAIF-Core-Profile-v1.0-Checklist.md](KAIF-Core-Profile-v1.0-Checklist.md)
   - Confirm readiness status and external release gates.

9. [review.md](review.md)
   - Ground expectations in current findings, risks, and recommended fixes.

10. [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
   - Use as an operator runbook when diagnosing real failures.

11. [packages/server/src/types/kaif.ts](packages/server/src/types/kaif.ts)
   - Treat this as the canonical contract surface for server and SDK behavior.

12. [packages/server/src/services/token-exchange.ts](packages/server/src/services/token-exchange.ts)
   - Inspect the highest-impact auth logic path in detail.

13. [conformance/README.md](conformance/README.md)
   - Validate interoperability claims and fixture-level expectations.

## Why This Order Works

- Context first: orientation and vocabulary before implementation details.
- Constraints second: protocol and security requirements before code internals.
- Verification last: conformance and troubleshooting to test understanding.

## Fast Path (15-20 Minutes)

If you are short on time, read these in order:

1. [index.md](index.md)
2. [SPEC.md](SPEC.md)
3. [SECURITY.md](SECURITY.md)
4. [review.md](review.md)

This gives a grounded view of what KAIF is, what it claims, and what remains to be closed.
