import { SettingsService } from '../settings';

export interface MatchRequest {
  serviceRequested: boolean;
  genderPreference?: 'MALE' | 'FEMALE' | 'OTHER';
  hasLocation: boolean;
  /** Distance cap used to normalise the distance factor. */
  maxDistanceKm?: number;
  specializations?: string[];
  maxPriceMinor?: number;
  availabilityRequested: boolean;
}

export interface MatchCandidate {
  nurseId: string;
  gender?: string | null;
  yearsOfExperience: number;
  averageRating: number;
  totalReviews: number;
  specializations: string[];
  distanceKm?: number | null;
  serviceRadiusKm: number;
  offersService: boolean;
  unitPriceMinor?: number | null;
  /** true/false when availability was evaluated, undefined when not requested */
  available?: boolean;
}

export interface ScoredNurse {
  nurseId: string;
  /** 0..100 */
  score: number;
  breakdown: Record<string, number>;
}

/**
 * Matching abstraction. Phase 2 ships RuleBasedMatchingService; an AIMatchingService can implement
 * the same interface later without touching search or booking code.
 */
export interface MatchingService {
  rank(request: MatchRequest, candidates: MatchCandidate[]): Promise<ScoredNurse[]>;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export class RuleBasedMatchingService implements MatchingService {
  constructor(private readonly loadWeights: () => Promise<Record<string, number>>) {}

  async rank(req: MatchRequest, candidates: MatchCandidate[]): Promise<ScoredNurse[]> {
    const w = await this.loadWeights();
    const prices = candidates.map((c) => c.unitPriceMinor).filter((p): p is number => p != null);
    const minP = prices.length ? Math.min(...prices) : 0;
    const maxP = prices.length ? Math.max(...prices) : 0;
    const wantSpec = (req.specializations ?? []).map((s) => s.toLowerCase());

    const scored = candidates.map((c): ScoredNurse => {
      const f: Record<string, number> = {
        availability: !req.availabilityRequested ? 1 : c.available ? 1 : 0,
        service: !req.serviceRequested || c.offersService ? 1 : 0,
        gender: !req.genderPreference ? 1 : c.gender === req.genderPreference ? 1 : 0,
        distance:
          !req.hasLocation || c.distanceKm == null
            ? 0.5
            : clamp01(1 - c.distanceKm / Math.max(1, req.maxDistanceKm ?? c.serviceRadiusKm)),
        experience: clamp01(c.yearsOfExperience / 10),
        specialization: wantSpec.length
          ? wantSpec.filter((s) => c.specializations.includes(s)).length / wantSpec.length
          : 1,
        // Few reviews => pull towards a neutral prior so one 5-star review doesn't outrank 200 good ones.
        rating: (() => {
          const n = Math.min(c.totalReviews, 10) / 10;
          return clamp01(n * (c.averageRating / 5) + (1 - n) * 0.6);
        })(),
        price: (() => {
          if (c.unitPriceMinor == null) return 0.5;
          if (req.maxPriceMinor) return clamp01(1 - c.unitPriceMinor / req.maxPriceMinor);
          return maxP === minP ? 1 : clamp01(1 - (c.unitPriceMinor - minP) / (maxP - minP));
        })(),
      };
      let total = 0;
      let weightSum = 0;
      for (const [k, factor] of Object.entries(f)) {
        const weight = w[k] ?? 0;
        total += weight * factor;
        weightSum += weight;
      }
      return {
        nurseId: c.nurseId,
        score: weightSum ? Math.round((total / weightSum) * 100) : 0,
        breakdown: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(v * 100)])),
      };
    });
    return scored.sort((a, b) => b.score - a.score);
  }
}

let instance: MatchingService = new RuleBasedMatchingService(() =>
  SettingsService.get('matching.weights'),
);
export const getMatchingService = (): MatchingService => instance;
/** Swap the strategy (e.g. an AI implementation, or a test double). */
export const setMatchingService = (m: MatchingService): void => {
  instance = m;
};
