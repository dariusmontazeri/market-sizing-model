// Research loop — Slice 1: the retry + tier-descent spine, CRAAP-driven.
//
// For ONE slot: the researcher finds a source (isolated call), CRAAP scores it
// cold (a SEPARATE isolated call), and CODE decides accept-or-retry. The retry
// budget IS the tier descent — attempt N targets tier N — for up to 3 attempts.
// We keep the best source across all attempts, not merely the first to pass.
//
// Isolation (Principle 7): the two components never share a conversation. The
// researcher hands CRAAP only a source package (the filled skeleton); CRAAP
// never sees the researcher's reasoning, and the researcher never sees CRAAP's
// scores. This module is the only place they meet, and it meets them through
// their public results, not their internals.
//
// AI vs code (Principle 5): the models emit judgments only — the researcher's
// extraction and CRAAP's per-dimension scores + Purpose gate. ALL arithmetic and
// control flow (the weighted blend, the threshold test, the gate decision, the
// retry, and keep-best) live here, in code.
//
// NOT in this slice (later): assumption fallback, search backoff/spacing for the
// web_search rate limit, early-stop-on-dead-end, and the proposer empty-turn fix.
import {
  researchSlot,
  type ResearchSkeleton,
  type ResearchSlot,
  type TierTarget,
} from "./researcher";
import {
  validateSkeleton,
  CRAAP_THRESHOLD,
  type CraapValidationResult,
  type SlotDefinition,
} from "./craapValidator";

const MAX_ATTEMPTS = 3;

export type LoopAttempt = {
  attempt: number; // 1-based
  tier: TierTarget; // = attempt (the budget IS the tier descent)
  skeleton: ResearchSkeleton; // the source package the researcher produced
  craap: CraapValidationResult; // CRAAP's cold scoring of that package
  blendedScore: number; // = craap.weightedTotal (computed in CRAAP code)
  purposePass: boolean; // = craap.purpose.gate === "pass"
  passed: boolean; // purposePass AND blendedScore >= threshold
  usage: { inputTokens: number; outputTokens: number }; // researcher + CRAAP
};

export type SlotLoopResult = {
  ok: true;
  slot: ResearchSlot;
  threshold: number;
  attempts: LoopAttempt[];
  winnerAttempt: number; // attempt number of the kept (best) source
  resolved: boolean; // the kept source passed CRAAP
  // All attempts failed; the best one is returned flagged. No proxy is built and
  // no value is invented — that is the (deferred) assumption fallback's job.
  failedThreshold: boolean;
  totalUsage: { inputTokens: number; outputTokens: number };
};

function toSlotDefinition(slot: ResearchSlot): SlotDefinition {
  return {
    geography: slot.geography,
    metric: slot.metric,
    definition: slot.definition,
  };
}

// Keep-best: a passing source always beats a failing one (a Purpose-gate failure
// disqualifies regardless of blend), and among same pass-status the higher blend
// wins. Order-independent — not "the first to pass on retry", since tier descent
// pulls progressively weaker sources.
function pickBest(attempts: LoopAttempt[]): LoopAttempt {
  return attempts.reduce((best, a) => {
    if (a.passed !== best.passed) return a.passed ? a : best;
    return a.blendedScore > best.blendedScore ? a : best;
  });
}

export async function resolveSlotWithRetry(
  slot: ResearchSlot,
): Promise<SlotLoopResult> {
  const slotDef = toSlotDefinition(slot);
  const attempts: LoopAttempt[] = [];
  const totalUsage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tier = attempt as TierTarget;
    // Tell the researcher which sources already failed so the retry pulls a
    // different one (code-supplied facts, not CRAAP's reasoning).
    const avoidPublishers = attempts
      .map((a) => a.skeleton.author_publisher)
      .filter((p): p is string => typeof p === "string" && p.trim() !== "");

    // Isolated call 1: the researcher finds a source for this tier.
    const found = await researchSlot(slot, { tier, attempt, avoidPublishers });
    // Isolated call 2: CRAAP scores the source package cold.
    const craap = await validateSkeleton(slotDef, found.skeleton);

    // Code decides: blend (from CRAAP code) vs threshold, AND the Purpose gate.
    const blendedScore = craap.weightedTotal;
    const purposePass = craap.purpose.gate === "pass";
    const passed = purposePass && blendedScore >= CRAAP_THRESHOLD;

    const usage = {
      inputTokens: found.usage.inputTokens + craap.usage.inputTokens,
      outputTokens: found.usage.outputTokens + craap.usage.outputTokens,
    };
    totalUsage.inputTokens += usage.inputTokens;
    totalUsage.outputTokens += usage.outputTokens;

    attempts.push({
      attempt,
      tier,
      skeleton: found.skeleton,
      craap,
      blendedScore,
      purposePass,
      passed,
      usage,
    });

    // Retry only on failure: a pass means we found an acceptable source, and
    // descending further would only reach weaker tiers.
    if (passed) break;
  }

  const winner = pickBest(attempts);
  return {
    ok: true,
    slot,
    threshold: CRAAP_THRESHOLD,
    attempts,
    winnerAttempt: winner.attempt,
    resolved: winner.passed,
    failedThreshold: !winner.passed,
    totalUsage,
  };
}
