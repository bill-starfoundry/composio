import { Data, Effect, Option } from 'effect';
import { ComposioUserContext } from 'src/services/user-context';
import { ComposioCliUserConfig } from 'src/services/cli-user-config';
import { ComposioClientSingleton } from 'src/services/composio-clients';
import {
  formatResolveCommandProjectError,
  resolveCommandProject,
} from 'src/services/command-project';
import { decodeConnectedAccountItemsWithFallback } from 'src/effects/decode-connected-account-list';

/**
 * Onboarding is state-driven: the state below is recomputed from durable
 * facts on every run, so resumability is emergent — `composio onboard`
 * simply starts at the first unsatisfied gate. The only persisted
 * onboarding state is `onboard.has_executed` in the CLI user config.
 */

/** Gate steps a user can complete (or explicitly skip). */
export const ONBOARD_GATE_STEPS = ['login', 'connect', 'execute'] as const;
export type OnboardGateStep = (typeof ONBOARD_GATE_STEPS)[number];

/** All skippable steps, including the opportunistic (non-gate) host step. */
export const ONBOARD_SKIPPABLE_STEPS = ['host', ...ONBOARD_GATE_STEPS] as const;
export type OnboardSkippableStep = (typeof ONBOARD_SKIPPABLE_STEPS)[number];

export const isOnboardSkippableStep = (value: string): value is OnboardSkippableStep =>
  ONBOARD_SKIPPABLE_STEPS.some(step => step === value);

export interface OnboardFacts {
  readonly loggedIn: boolean;
  readonly hasConnection: boolean;
  readonly hasExecuted: boolean;
  readonly skippedSteps: ReadonlyArray<string>;
}

export interface OnboardState extends OnboardFacts {
  readonly orgSelected: boolean;
  readonly orgId: string | undefined;
  readonly connectedToolkits: ReadonlyArray<string>;
  readonly connectionCount: number;
  /** True when the connection lookup failed (offline / API error). */
  readonly connectionCheckFailed: boolean;
  readonly onboardedAt: string | undefined;
  readonly nextStep: OnboardGateStep | undefined;
  readonly complete: boolean;
}

/** Completion is strict: skips do not count as completion. */
export const isOnboardComplete = (facts: OnboardFacts): boolean =>
  facts.loggedIn && facts.hasConnection && facts.hasExecuted;

/**
 * First unsatisfied, non-skipped gate. A skipped gate also blocks the
 * steps behind it (you cannot connect while logged out, or execute a
 * connected tool without a connection), so a skip earlier in the chain
 * yields `undefined` (nothing actionable) rather than a later step.
 */
export const resolveNextOnboardStep = (facts: OnboardFacts): OnboardGateStep | undefined => {
  const skipped = new Set(facts.skippedSteps);
  if (!facts.loggedIn) {
    return skipped.has('login') ? undefined : 'login';
  }
  if (!facts.hasConnection) {
    return skipped.has('connect') ? undefined : 'connect';
  }
  if (!facts.hasExecuted) {
    return skipped.has('execute') ? undefined : 'execute';
  }
  return undefined;
};

interface ConnectionSnapshot {
  readonly toolkits: ReadonlyArray<string>;
  readonly count: number;
  readonly failed: boolean;
}

const NO_CONNECTIONS: ConnectionSnapshot = { toolkits: [], count: 0, failed: false };

class OnboardConnectionLookupError extends Data.TaggedError(
  'services/OnboardConnectionLookupError'
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Best-effort lookup of the user's ACTIVE connected accounts in the
 * consumer project. Failures (offline, expired credentials, missing
 * consumer user) degrade to "no connections, lookup failed" instead of
 * failing the caller — onboarding must always be able to render state.
 */
const fetchConnectionSnapshot = Effect.gen(function* () {
  const clientSingleton = yield* ComposioClientSingleton;
  const resolvedProject = yield* resolveCommandProject({ mode: 'consumer' }).pipe(
    Effect.mapError(formatResolveCommandProjectError)
  );
  const consumerUserId = resolvedProject.consumerUserId;
  if (!consumerUserId) {
    return NO_CONNECTIONS;
  }
  const client = yield* clientSingleton.getFor({
    orgId: resolvedProject.orgId,
    projectId: resolvedProject.projectId,
  });
  const response = yield* Effect.tryPromise({
    try: () =>
      client.connectedAccounts.list({
        user_ids: [consumerUserId],
        statuses: ['ACTIVE'],
        limit: 100,
      }),
    catch: cause =>
      new OnboardConnectionLookupError({
        message: 'Failed to list connected accounts while computing onboarding state.',
        cause,
      }),
  });
  const items = yield* decodeConnectedAccountItemsWithFallback(response.items);
  const toolkits = [...new Set(items.map(item => item.toolkit.slug.toLowerCase()))];
  return { toolkits, count: items.length, failed: false } satisfies ConnectionSnapshot;
});

/**
 * Compute the current onboarding state from durable facts. Read-only:
 * never mutates config, never prompts. Network access is limited to the
 * connected-accounts lookup and only happens when logged in.
 */
export const computeOnboardState = Effect.gen(function* () {
  const ctx = yield* ComposioUserContext;
  const cliConfig = yield* ComposioCliUserConfig;

  const loggedIn = ctx.isLoggedIn();
  const orgId = Option.getOrUndefined(ctx.data.orgId);
  const onboard = cliConfig.data.onboard;

  const connections = loggedIn
    ? yield* fetchConnectionSnapshot.pipe(
        Effect.catchAll(cause =>
          Effect.logDebug('Onboard connection lookup failed:', cause).pipe(
            Effect.as({ toolkits: [], count: 0, failed: true } satisfies ConnectionSnapshot)
          )
        )
      )
    : NO_CONNECTIONS;

  const facts: OnboardFacts = {
    loggedIn,
    hasConnection: connections.count > 0,
    hasExecuted: onboard.hasExecuted,
    skippedSteps: onboard.skippedSteps,
  };

  return {
    ...facts,
    orgSelected: orgId !== undefined,
    orgId,
    connectedToolkits: connections.toolkits,
    connectionCount: connections.count,
    connectionCheckFailed: connections.failed,
    onboardedAt: onboard.onboardedAt,
    // Persisted skips are a funnel record, not a permanent block: the
    // baseline next step ignores them. `composio onboard` applies the
    // current invocation's `--skip` flags on top via
    // `resolveNextOnboardStep` when deciding what to run.
    nextStep: resolveNextOnboardStep({ ...facts, skippedSteps: [] }),
    complete: isOnboardComplete(facts),
  } satisfies OnboardState;
});

/**
 * Flip `onboard.has_executed` after the first successful tool execution.
 * Idempotent: returns `true` only on the first flip, `false` afterwards.
 * Persistence failures are swallowed — telemetry state must never break
 * an otherwise successful execute.
 */
export const recordOnboardExecuted = Effect.gen(function* () {
  const cliConfig = yield* ComposioCliUserConfig;
  if (cliConfig.data.onboard.hasExecuted) {
    return false;
  }
  yield* cliConfig.update({
    onboard: {
      ...cliConfig.raw.onboard,
      hasExecuted: true,
      onboardedAt: Option.some(new Date().toISOString()),
    },
  });
  return true;
}).pipe(Effect.catchAll(() => Effect.succeed(false)));

/** Persist newly skipped steps (merged, deduplicated). */
export const recordOnboardSkippedSteps = (steps: ReadonlyArray<OnboardSkippableStep>) =>
  Effect.gen(function* () {
    if (steps.length === 0) return;
    const cliConfig = yield* ComposioCliUserConfig;
    const merged = [...new Set([...cliConfig.raw.onboard.skippedSteps, ...steps])];
    if (merged.length === cliConfig.raw.onboard.skippedSteps.length) return;
    yield* cliConfig.update({
      onboard: {
        ...cliConfig.raw.onboard,
        skippedSteps: merged,
      },
    });
  }).pipe(Effect.catchAll(() => Effect.void));

/**
 * One-line nudge for bare `composio` when onboarding is incomplete,
 * computed from local facts only (no network). Returns `undefined` when
 * the user looks onboarded — callers fall back to full help.
 */
export const getLocalOnboardNudge = (facts: {
  readonly loggedIn: boolean;
  readonly hasExecuted: boolean;
}): string | undefined => {
  if (facts.loggedIn && facts.hasExecuted) {
    return undefined;
  }
  const next = facts.loggedIn
    ? 'connect an app and run your first tool'
    : 'log in to your Composio account';
  return [
    'Welcome to Composio — connect AI agents to 1000+ apps.',
    '',
    'Finish getting set up (resumable, takes ~2 minutes):',
    '',
    '  composio onboard',
    '',
    `Next step: ${next}.`,
    'Run `composio --help` to see all commands.',
  ].join('\n');
};
