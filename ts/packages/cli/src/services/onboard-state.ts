import { Data, Effect, Option } from 'effect';
import { ComposioUserContext } from 'src/services/user-context';
import { ComposioCliUserConfig } from 'src/services/cli-user-config';
import { ComposioClientSingleton } from 'src/services/composio-clients';
import {
  formatResolveCommandProjectError,
  resolveCommandProject,
} from 'src/services/command-project';
import { decodeConnectedAccountItemsWithFallback } from 'src/effects/decode-connected-account-list';

export const ONBOARD_GATE_STEPS = ['login', 'connect', 'execute'] as const;
export type OnboardGateStep = (typeof ONBOARD_GATE_STEPS)[number];

export const ONBOARD_SKIPPABLE_STEPS = ONBOARD_GATE_STEPS;
export type OnboardSkippableStep = OnboardGateStep;

export const isOnboardSkippableStep = (value: string): value is OnboardSkippableStep =>
  ONBOARD_SKIPPABLE_STEPS.some(step => step === value);

export interface OnboardFacts {
  readonly loggedIn: boolean;
  readonly hasConnection: boolean;
  readonly hasExecuted: boolean;
  readonly skippedSteps: ReadonlyArray<string>;
  readonly connectionCheckFailed?: boolean;
}

export interface OnboardState extends OnboardFacts {
  readonly orgSelected: boolean;
  readonly orgId: string | undefined;
  readonly connectedToolkits: ReadonlyArray<string>;
  readonly connectionCount: number;
  readonly connectionCheckFailed: boolean;
  readonly onboardedAt: string | undefined;
  readonly nextStep: OnboardGateStep | undefined;
  readonly complete: boolean;
}

export const isOnboardComplete = (facts: OnboardFacts): boolean =>
  facts.loggedIn && facts.hasConnection && facts.hasExecuted;

export const resolveNextOnboardStep = (facts: OnboardFacts): OnboardGateStep | undefined => {
  const skipped = new Set(facts.skippedSteps);
  if (!facts.loggedIn) {
    return skipped.has('login') ? undefined : 'login';
  }
  if (!facts.hasConnection) {
    if (facts.connectionCheckFailed) {
      return undefined;
    }
    return skipped.has('connect') ? undefined : 'connect';
  }
  if (!facts.hasExecuted) {
    return skipped.has('execute') ? undefined : 'execute';
  }
  return undefined;
};

export interface OnboardResolution {
  readonly completed: ReadonlyArray<OnboardGateStep>;
  readonly remaining: ReadonlyArray<OnboardGateStep>;
  readonly skipped: ReadonlyArray<OnboardSkippableStep>;
  readonly persistedSkips: ReadonlyArray<OnboardSkippableStep>;
  readonly nextStep: OnboardGateStep | undefined;
  readonly complete: boolean;
  readonly connectionUnknown: boolean;
}

const gateSatisfied = (facts: OnboardFacts, gate: OnboardGateStep): boolean =>
  gate === 'login' ? facts.loggedIn : gate === 'connect' ? facts.hasConnection : facts.hasExecuted;

export const resolveOnboard = (params: {
  readonly facts: OnboardFacts;
  readonly invocationSkips: ReadonlyArray<OnboardSkippableStep>;
}): OnboardResolution => {
  const { facts } = params;
  const persistedSkips = facts.skippedSteps.filter(isOnboardSkippableStep);
  const effectiveSkips = new Set<OnboardSkippableStep>(params.invocationSkips);
  const connectionUnknown = Boolean(facts.connectionCheckFailed) && !facts.hasConnection;
  const isUnresolvableGate = (gate: OnboardGateStep): boolean =>
    connectionUnknown && gate !== 'login';

  const completed = ONBOARD_GATE_STEPS.filter(gate => gateSatisfied(facts, gate));
  const nextStep = resolveNextOnboardStep({ ...facts, skippedSteps: params.invocationSkips });

  const remaining: OnboardGateStep[] = [];
  for (const gate of ONBOARD_GATE_STEPS) {
    if (completed.includes(gate)) continue;
    if (effectiveSkips.has(gate) || isUnresolvableGate(gate)) break;
    remaining.push(gate);
  }

  const skipped = [...effectiveSkips].filter(
    step => !completed.includes(step) && !isUnresolvableGate(step)
  );

  return {
    completed,
    remaining,
    skipped,
    persistedSkips,
    nextStep,
    complete: isOnboardComplete(facts),
    connectionUnknown,
  };
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
    hasConnection: connections.count > 0 || (connections.failed && onboard.hasExecuted),
    hasExecuted: onboard.hasExecuted,
    skippedSteps: onboard.skippedSteps,
    connectionCheckFailed: connections.failed,
  };

  return {
    ...facts,
    orgSelected: orgId !== undefined,
    orgId,
    connectedToolkits: connections.toolkits,
    connectionCount: connections.count,
    connectionCheckFailed: connections.failed,
    onboardedAt: onboard.onboardedAt,
    nextStep: resolveNextOnboardStep({ ...facts, skippedSteps: [] }),
    complete: isOnboardComplete(facts),
  } satisfies OnboardState;
});

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
