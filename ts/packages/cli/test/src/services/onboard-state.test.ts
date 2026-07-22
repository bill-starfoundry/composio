import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import {
  getLocalOnboardNudge,
  isOnboardComplete,
  isOnboardSkippableStep,
  recordOnboardExecuted,
  recordOnboardSkippedSteps,
  resolveNextOnboardStep,
  type OnboardFacts,
} from 'src/services/onboard-state';
import { ComposioCliUserConfig } from 'src/services/cli-user-config';
import { CliUserConfig } from 'src/models/cli-user-config';

const facts = (overrides: Partial<OnboardFacts>): OnboardFacts => ({
  loggedIn: false,
  hasConnection: false,
  hasExecuted: false,
  skippedSteps: [],
  ...overrides,
});

describe('resolveNextOnboardStep', () => {
  it('resolves login first for a fresh install', () => {
    expect(resolveNextOnboardStep(facts({}))).toBe('login');
  });

  it('resolves connect once logged in without connections', () => {
    expect(resolveNextOnboardStep(facts({ loggedIn: true }))).toBe('connect');
  });

  it('resolves execute once connected but never executed', () => {
    expect(resolveNextOnboardStep(facts({ loggedIn: true, hasConnection: true }))).toBe('execute');
  });

  it('resolves nothing once complete', () => {
    expect(
      resolveNextOnboardStep(facts({ loggedIn: true, hasConnection: true, hasExecuted: true }))
    ).toBeUndefined();
  });

  it('heals partial states: logged out again resumes at login even with has_executed', () => {
    expect(resolveNextOnboardStep(facts({ hasExecuted: true }))).toBe('login');
  });

  it('heals partial states: zero connections resumes at connect even with has_executed', () => {
    expect(resolveNextOnboardStep(facts({ loggedIn: true, hasExecuted: true }))).toBe('connect');
  });

  it('a skipped gate yields nothing actionable instead of a later gate', () => {
    expect(resolveNextOnboardStep(facts({ skippedSteps: ['login'] }))).toBeUndefined();
    expect(
      resolveNextOnboardStep(facts({ loggedIn: true, skippedSteps: ['connect'] }))
    ).toBeUndefined();
    expect(
      resolveNextOnboardStep(
        facts({ loggedIn: true, hasConnection: true, skippedSteps: ['execute'] })
      )
    ).toBeUndefined();
  });

  it('skips only apply to their own gate', () => {
    expect(resolveNextOnboardStep(facts({ skippedSteps: ['execute'] }))).toBe('login');
    expect(resolveNextOnboardStep(facts({ loggedIn: true, skippedSteps: ['login'] }))).toBe(
      'connect'
    );
  });

  it('a failed connection check does not route to connect (degraded, not unsatisfied)', () => {
    expect(
      resolveNextOnboardStep(
        facts({ loggedIn: true, hasConnection: false, connectionCheckFailed: true })
      )
    ).toBeUndefined();
  });

  it('a known "no connection" still routes to connect when the check succeeded', () => {
    expect(
      resolveNextOnboardStep(
        facts({ loggedIn: true, hasConnection: false, connectionCheckFailed: false })
      )
    ).toBe('connect');
  });
});

describe('isOnboardComplete', () => {
  it('requires all three gates; skips never count as completion', () => {
    expect(
      isOnboardComplete(facts({ loggedIn: true, hasConnection: true, hasExecuted: true }))
    ).toBe(true);
    expect(isOnboardComplete(facts({ loggedIn: true, hasConnection: true }))).toBe(false);
    expect(
      isOnboardComplete(facts({ loggedIn: true, hasConnection: true, skippedSteps: ['execute'] }))
    ).toBe(false);
  });
});

describe('isOnboardSkippableStep', () => {
  it('accepts the three gates, rejects anything else', () => {
    expect(isOnboardSkippableStep('login')).toBe(true);
    expect(isOnboardSkippableStep('connect')).toBe(true);
    expect(isOnboardSkippableStep('execute')).toBe(true);
    expect(isOnboardSkippableStep('host')).toBe(false);
    expect(isOnboardSkippableStep('search')).toBe(false);
    expect(isOnboardSkippableStep('')).toBe(false);
  });
});

describe('getLocalOnboardNudge', () => {
  it('nudges towards login when logged out', () => {
    const nudge = getLocalOnboardNudge({ loggedIn: false, hasExecuted: false });
    expect(nudge).toContain('composio onboard');
    expect(nudge).toContain('log in');
  });

  it('nudges towards first execution when logged in but never executed', () => {
    const nudge = getLocalOnboardNudge({ loggedIn: true, hasExecuted: false });
    expect(nudge).toContain('composio onboard');
    expect(nudge).toContain('first tool');
  });

  it('returns undefined when the user looks onboarded', () => {
    expect(getLocalOnboardNudge({ loggedIn: true, hasExecuted: true })).toBeUndefined();
  });
});

const makeConfigStub = () => {
  let raw = CliUserConfig.make({
    developer: { enabled: true, destructiveActions: false },
    experimentalFeatures: {},
    artifactDirectory: Option.none(),
    experimentalSubagent: Option.none(),
    security: 'auto',
  });
  const layer = Layer.succeed(
    ComposioCliUserConfig,
    ComposioCliUserConfig.of({
      get data() {
        return {
          channel: 'beta' as const,
          developerModeEnabled: true,
          developerDangerousCommandsEnabled: false,
          experimentalFeatures: {},
          artifactDirectory: undefined,
          experimentalSubagentTarget: 'auto' as const,
          security: 'auto' as const,
          onboard: {
            hasExecuted: raw.onboard.hasExecuted,
            onboardedAt: Option.getOrUndefined(raw.onboard.onboardedAt),
            skippedSteps: raw.onboard.skippedSteps,
          },
        };
      },
      get raw() {
        return raw;
      },
      channel: 'beta',
      isDevModeEnabled: () => true,
      areDeveloperDangerousCommandsEnabled: () => false,
      isExperimentalFeatureEnabled: () => false,
      update: next =>
        Effect.sync(() => {
          raw = CliUserConfig.make({ ...raw, ...next });
        }),
    })
  );
  return { layer, getRaw: () => raw };
};

describe('recordOnboardExecuted', () => {
  it.effect('flips has_executed exactly once', () => {
    const stub = makeConfigStub();
    return Effect.gen(function* () {
      const first = yield* recordOnboardExecuted;
      const second = yield* recordOnboardExecuted;
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(stub.getRaw().onboard.hasExecuted).toBe(true);
      expect(Option.isSome(stub.getRaw().onboard.onboardedAt)).toBe(true);
    }).pipe(Effect.provide(stub.layer));
  });
});

describe('recordOnboardSkippedSteps', () => {
  it.effect('merges and deduplicates skipped steps', () => {
    const stub = makeConfigStub();
    return Effect.gen(function* () {
      yield* recordOnboardSkippedSteps(['execute']);
      yield* recordOnboardSkippedSteps(['execute', 'connect']);
      expect([...stub.getRaw().onboard.skippedSteps].sort()).toEqual(['connect', 'execute']);
    }).pipe(Effect.provide(stub.layer));
  });
});
