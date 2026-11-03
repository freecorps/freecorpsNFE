---
name: principle-prove-it-works
description: "Apply after completing a task, before declaring done. Verify against the real artifact (run the feature, read the actual value, inspect the diff), not a proxy, self-report, or 'it compiles.'"
disable-model-invocation: true
---

# Prove It Works

Verify every task output by checking the real thing directly. Do not infer from proxies, self-reports, or "it compiles."

**Why:** Unverified work has unknown correctness. Indirect verification (file mtimes, output freshness, agent self-reports, cached screenshots) feels cheaper than direct observation. Acting on a wrong inference costs far more than checking the source.

**Pattern:** After completing any task, ask: "how do I prove this actually works?"

Check the real thing, not a proxy:
- Check process liveness directly, not indirectly through derived state
- Read the actual value, not a cached or derived representation
- When verification fails, suspect the observation method before suspecting the system

Code and features:
1. Build it (necessary but not sufficient)
2. Run it and exercise the actual feature path
3. Check the full chain: does data flow from input to output?
4. For integrations, test the full communication path end-to-end

Delegation: trust artifacts, not self-reports.
When verifying delegated work, inspect the actual output artifact (git diff, file contents, runtime behavior), not the delegate's summary. Agents report what they intended, not always what happened.

## Script the check when you can

The strongest proof is a deterministic script that re-runs the same comparison, not a one-time eyeball. Write the script, run it, and keep its output as an artifact a reviewer can re-run instead of trusting your word. A script comparing the old and new compiled output catches what a glance misses.

Keep the artifact visible for the human. Commit it only for large or complex work where the trail has to be auditable later, like a big port or migration (the **show-me-your-work** skill). Most work just needs it visible, not committed.

## Verify a specific claim

For a claim such as "this fix prevents the duplicate", state the condition
and observable result that would disprove it. Add a metric and threshold only
when the claim is quantitative. Use the smallest real path that reaches the
behavior, including the side effects the claim concerns.

For a before/after claim, capture a baseline and the changed result using the
same command, synthetic data and relevant environment. Identify the revisions
and local changes. Compare the raw artifacts, not the agent's summaries.
Preserve local work when obtaining a baseline; do not reset the dev's checkout.
For performance claims, follow
[performance-analysis](../performance-analysis/SKILL.md).

Conclude with one verdict for the stated claim:

- **Comprovado:** the evidence meets the claim, with no unresolved confound
  that invalidates the comparison.
- **Não comprovado:** a valid check contradicts the claim or misses its
  threshold. State the observed result.
- **Inconclusivo:** missing baseline when the claim requires one, unavailable
  environment, noise or invalid measurement prevents deciding.

A new feature can be checked against its contract without inventing an old
failure. Keep the verdict scoped to what was exercised. A compiler pass does
not prove a user journey, and a simulated fiscal response does not prove real
authorization. Report the commands, evidence and limits proportionally to the
claim. Use temporary paths appropriate to the host, including `$env:TEMP` on
Windows, and synthetic artifacts without credentials or real customer data.
