// Slot-results cache (V6.16.2) — a deterministic replay / lookup table, the
// "receipt drawer". It makes iteration CHEAPER and FASTER, never SMARTER: it
// stores results that already came from properly isolated calls, does not train
// on its own runs, and CRAAP cannot distinguish a cached skeleton from a fresh
// one. Component independence is untouched.
//
// Design rules (locked in the planner):
//  - Cache on ACCEPT only, never on attempt. Only a skeleton that CLEARED the
//    CRAAP threshold is stored (a garbled-but-schema-valid skeleton would
//    otherwise poison the cache). The CRAAP score is stored WITH the result so
//    a hit skips both the researcher and CRAAP.
//  - Local file-based JSON now (zero infra, enough for Phase-4 Germany
//    iteration); a hosted KV store comes at pre-launch. Everything goes through
//    the thin get/set interface below so that swap is contained.
//  - OFF by default, opt-in via the RESEARCH_CACHE env flag — same posture as
//    the structure pin. Production (flag off) always does live research.
//
// Key: hash of the slot's defining fields (kind, filterIndex, geography,
// metric, definition). With the pin ON these are fully deterministic. Once the
// live proposer feeds this (non-deterministic wording), differing prose keys
// MISS — an efficiency cost, never a correctness one; the stable-fields key of
// V6.16.2 belongs to the hosted layer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ResearchSlot, ResearchSkeleton } from "./researcher";
import type { CraapValidationResult } from "./craapValidator";

const CACHE_ON_VALUES = new Set(["1", "true", "on"]);

// Is the slot-results cache engaged? Reads the env at call time (not module
// load) so tests and dev sessions see the current value. Default OFF.
export function isResearchCacheEnabled(): boolean {
  const v = process.env.RESEARCH_CACHE;
  return typeof v === "string" && CACHE_ON_VALUES.has(v.trim().toLowerCase());
}

// STALENESS (V6.17): a cached entry replays the CRAAP scores it earned when it
// was researched — including Currency, which was graded against THAT date. The
// TTL bounds how long that grade is trusted: entries older than the TTL are a
// MISS and get re-researched live. Default 30 days; override with
// RESEARCH_CACHE_TTL_DAYS for a long-lived showcase (which must then surface
// its "last sourced" date) or a tighter dev window.
const DEFAULT_TTL_DAYS = 30;

export function cacheTtlDays(): number {
  const raw = process.env.RESEARCH_CACHE_TTL_DAYS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
}

function cacheDir(): string {
  return (
    process.env.RESEARCH_CACHE_DIR ??
    path.join(process.cwd(), ".research-cache")
  );
}

export type CachedSlotResult = {
  // Provenance of the cache entry itself — surfaced so a replayed result is
  // transparently a prior run, never a live pull masquerade.
  cachedAt: string; // ISO timestamp of the ACCEPTED live run
  slotKey: string;
  skeleton: ResearchSkeleton;
  craap: CraapValidationResult;
  researcherModel: string;
};

export function slotCacheKey(slot: ResearchSlot): string {
  const material = JSON.stringify({
    kind: slot.kind,
    filterIndex: slot.filterIndex,
    geography: slot.geography,
    metric: slot.metric,
    definition: slot.definition,
  });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function entryPath(key: string): string {
  return path.join(cacheDir(), `${key}.json`);
}

// Thin get/set — the seam a hosted KV store replaces at pre-launch.
export function cacheGet(slot: ResearchSlot): CachedSlotResult | null {
  if (!isResearchCacheEnabled()) return null;
  const file = entryPath(slotCacheKey(slot));
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as CachedSlotResult;
    // Minimal integrity check — a hand-edited or truncated entry is a MISS,
    // never a crash and never a half-trusted value.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.cachedAt !== "string" ||
      !parsed.skeleton ||
      !parsed.craap
    ) {
      return null;
    }
    // TTL gate: an entry older than the TTL is STALE — its Currency grade no
    // longer describes the data's age — so it is a miss and re-researches live.
    const ageMs = Date.now() - Date.parse(parsed.cachedAt);
    if (!Number.isFinite(ageMs) || ageMs > cacheTtlDays() * 86_400_000) {
      return null;
    }
    return parsed;
  } catch {
    return null; // missing/unreadable file is simply a miss
  }
}

export function cacheSet(
  slot: ResearchSlot,
  entry: Omit<CachedSlotResult, "cachedAt" | "slotKey">,
): void {
  if (!isResearchCacheEnabled()) return;
  const key = slotCacheKey(slot);
  const record: CachedSlotResult = {
    cachedAt: new Date().toISOString(),
    slotKey: key,
    ...entry,
  };
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(entryPath(key), JSON.stringify(record, null, 2), "utf8");
}
