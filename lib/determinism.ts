// The trial clock and seed. Nothing in this forge ever reads the wall clock
// (no Date.now(), no new Date() on a live value) or unseeded randomness:
// every timestamp a request can see comes from MAKEFUN_TRIAL_NOW, an RFC 3339
// instant or epoch milliseconds. When the variable is absent (local runs)
// a fixed constant stands in, so two runs still agree.

const FALLBACK_NOW_MS = 1700000000000; // 2023-11-14T22:13:20.000Z, fixed

/** The trial's fixed now, in epoch milliseconds. */
export function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw === undefined || raw.trim() === '') return FALLBACK_NOW_MS;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isSafeInteger(ms) ? ms : FALLBACK_NOW_MS;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : FALLBACK_NOW_MS;
}

/** The trial's fixed now as an RFC 3339 instant. */
export function trialNowIso(): string {
  return new Date(trialNowMs()).toISOString();
}

/** The trial's fixed now as epoch seconds (git commit timestamps). */
export function trialNowSec(): number {
  return Math.floor(trialNowMs() / 1000);
}

/** The trial's seed, for any choice that needs seeding (unused: the forge is fully deterministic). */
export function trialSeed(): string {
  return process.env.MAKEFUN_TRIAL_SEED ?? '';
}

/** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN). */
export function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}
