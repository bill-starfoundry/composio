import { Command, HelpDoc, Options, ValidationError } from '@effect/cli';
import { Effect, Option } from 'effect';
import { TerminalUI } from 'src/services/terminal-ui';
import { ComposioUserContext } from 'src/services/user-context';
import { ComposioCliUserConfig } from 'src/services/cli-user-config';
import {
  computeOnboardState,
  isOnboardSkippableStep,
  ONBOARD_SKIPPABLE_STEPS,
  recordOnboardSkippedSteps,
  resolveOnboard,
  type OnboardGateStep,
  type OnboardResolution,
  type OnboardSkippableStep,
  type OnboardState,
} from 'src/services/onboard-state';
import {
  findOnboardTaskByToolkit,
  findOnboardTaskForConnectedToolkits,
  FREE_TEXT_TASK_ID,
  matchOnboardTask,
  ONBOARD_TASKS,
  type OnboardExecuteSummarizer,
  type OnboardFollowUpCreate,
  type OnboardTask,
} from 'src/services/onboard-tasks';
import { browserLogin } from 'src/commands/login.cmd';
import {
  runToolsSearch,
  type ToolsSearchSummary,
} from 'src/commands/tools/commands/tools.search.cmd';
import { runConnectedAccountsLink } from 'src/commands/connected-accounts/commands/connected-accounts.link.cmd';
import { runToolsExecute } from 'src/commands/tools/commands/tools.execute.cmd';
import type { ToolExecuteResponse } from 'src/services/tools-executor';
import { CLI_ANALYTICS_EVENTS, getOnboardFunnelEvent } from 'src/analytics/events';
import { trackCliEventEffect } from 'src/analytics/dispatch';
import { commandHintStep } from 'src/services/command-hints';

const human = Options.boolean('human').pipe(
  Options.withDefault(false),
  Options.withDescription('Show formatted human-readable output instead of default JSON')
);

const json = Options.boolean('json').pipe(
  Options.withDefault(false),
  Options.withDescription('Print machine-readable state JSON (default when output is piped)')
);

const yes = Options.boolean('yes').pipe(
  Options.withAlias('y'),
  Options.withDefault(false),
  Options.withDescription('Accept prompts (org picker, demo run) without asking')
);

const task = Options.text('task').pipe(
  Options.withDescription('Pick a starter task without the menu (e.g. "read my gmail")'),
  Options.optional
);

const toolkitOpt = Options.text('toolkit').pipe(
  Options.withDescription('Pick a starter toolkit without the menu (e.g. "github")'),
  Options.optional
);

const skip = Options.text('skip').pipe(
  Options.withDescription(
    `Skip a step (${ONBOARD_SKIPPABLE_STEPS.join(', ')}). Repeat for multiple.`
  ),
  Options.repeated
);

const statusOpt = Options.boolean('status').pipe(
  Options.withDefault(false),
  Options.withDescription('Show onboarding status and exit without changing anything')
);

const invalidOptionValue = (message: string) => ValidationError.invalidValue(HelpDoc.p(message));

type OnboardEventName =
  | typeof CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STARTED
  | typeof CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_STARTED
  | typeof CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_COMPLETED
  | typeof CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_SKIPPED
  | typeof CLI_ANALYTICS_EVENTS.CLI_ONBOARD_COMPLETED
  | typeof CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STATUS_VIEWED;

const track = (name: OnboardEventName, step?: string, properties?: Record<string, unknown>) =>
  trackCliEventEffect(getOnboardFunnelEvent({ name, step, properties }));

const stateLabel = (state: OnboardState): string => {
  if (state.complete) return 'complete';
  if (!state.loggedIn) return 'logged_out';
  if (!state.hasConnection) return 'logged_in';
  return 'connected';
};

export const nextCommandFor = (
  state: OnboardState,
  nextStep: OnboardGateStep | undefined
): { readonly step: OnboardGateStep; readonly cmd: string } | null => {
  switch (nextStep) {
    case 'login':
      return { step: 'login', cmd: 'composio login' };
    case 'connect':
      return { step: 'connect', cmd: `composio onboard --toolkit ${ONBOARD_TASKS[0].toolkit}` };
    case 'execute': {
      const connectedTask = findOnboardTaskForConnectedToolkits(state.connectedToolkits);
      return connectedTask
        ? { step: 'execute', cmd: `composio onboard --toolkit ${connectedTask.toolkit}` }
        : { step: 'execute', cmd: 'composio search "<what you want to do>"' };
    }
    default:
      return null;
  }
};

const resolutionFor = (
  state: OnboardState,
  invocationSkips: ReadonlyArray<OnboardSkippableStep>
): OnboardResolution => resolveOnboard({ facts: state, invocationSkips });

export const buildStateJson = (params: {
  readonly state: OnboardState;
  readonly invocationSkips: ReadonlyArray<OnboardSkippableStep>;
  readonly hint?: string;
}): string => {
  const { state } = params;
  const resolution = resolutionFor(state, params.invocationSkips);
  return JSON.stringify(
    {
      state: stateLabel(state),
      completed: resolution.completed,
      remaining: resolution.remaining,
      skipped: resolution.skipped,
      ...(resolution.persistedSkips.length > 0
        ? { persisted_skips: resolution.persistedSkips }
        : {}),
      connections: {
        count: state.connectionCount,
        toolkits: state.connectedToolkits,
        ...(state.connectionCheckFailed ? { check_failed: true } : {}),
      },
      ...(state.orgId ? { org_id: state.orgId } : {}),
      next: nextCommandFor(state, resolution.nextStep),
      ...(params.hint ? { hint: params.hint } : {}),
    },
    null,
    2
  );
};

const emitStatus = (params: {
  readonly ui: TerminalUI;
  readonly state: OnboardState;
  readonly invocationSkips: ReadonlyArray<OnboardSkippableStep>;
  readonly emitHuman: boolean;
  readonly emitJson: boolean;
  readonly forceJson: boolean;
  readonly withIntro: boolean;
}) =>
  Effect.gen(function* () {
    const { ui, state } = params;
    const resolution = resolutionFor(state, params.invocationSkips);
    if (params.withIntro) {
      yield* ui.intro('composio onboard');
    }

    if (state.loggedIn) {
      yield* ui.log.success(`Logged in${state.orgId ? ` (org ${state.orgId})` : ''}`);
    } else {
      yield* ui.log.warn('Not logged in');
    }
    if (state.connectionCheckFailed) {
      yield* ui.log.warn('Connections: unknown (could not reach the Composio API)');
    } else if (state.connectionCount > 0) {
      yield* ui.log.success(
        `${state.connectionCount} connection${state.connectionCount === 1 ? '' : 's'}: ${state.connectedToolkits.join(', ')}`
      );
    } else {
      yield* ui.log.warn('No connected apps yet');
    }
    yield* state.hasExecuted
      ? ui.log.success('First tool execution: done')
      : ui.log.warn('First tool execution: not yet');

    const next = nextCommandFor(state, resolution.nextStep);
    if (resolution.complete) {
      yield* ui.log.info(
        [
          commandHintStep('Find tools', 'root.search'),
          commandHintStep('Execute a tool', 'root.execute'),
          'Run a script:\n> composio run \'const me = await execute("GITHUB_GET_THE_AUTHENTICATED_USER"); console.log(me)\'',
        ].join('\n')
      );
      yield* ui.outro("You're all set!");
    } else if (next) {
      yield* ui.outro(`Next: ${next.cmd}`);
    } else if (resolution.connectionUnknown) {
      yield* ui.outro(
        "Couldn't reach the Composio API to check your connections. Check your network and re-run `composio onboard`."
      );
    } else {
      yield* ui.outro(
        'Nothing to do (remaining steps were skipped). Re-run without --skip to continue.'
      );
    }

    if (params.emitJson || !params.emitHuman) {
      yield* ui.output(
        buildStateJson({
          state,
          invocationSkips: params.invocationSkips,
        }),
        params.forceJson ? { force: true } : undefined
      );
    }
  });

interface TaskSelection {
  readonly task: OnboardTask | undefined;
  readonly toolkit: string | undefined;
  readonly query: string;
}

const selectionFromToolkit = (rawToolkit: string): TaskSelection => {
  const toolkit = rawToolkit.trim().toLowerCase();
  const curated = findOnboardTaskByToolkit(toolkit);
  return {
    task: curated,
    toolkit,
    query: curated?.searchQuery ?? `things I can do with ${toolkit}`,
  };
};

const selectionFromTaskText = (text: string): TaskSelection => {
  const curated = matchOnboardTask(text);
  return curated
    ? { task: curated, toolkit: curated.toolkit, query: curated.searchQuery }
    : { task: undefined, toolkit: undefined, query: text.trim() };
};

const resolveInteractiveSelection = (params: {
  readonly ui: TerminalUI;
  readonly toolkit: Option.Option<string>;
  readonly task: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    if (Option.isSome(params.toolkit)) {
      return selectionFromToolkit(params.toolkit.value);
    }
    if (Option.isSome(params.task)) {
      return selectionFromTaskText(params.task.value);
    }

    const choice = yield* params.ui.select<string>('What do you want to try first?', [
      ...ONBOARD_TASKS.map(candidate => ({
        value: candidate.id,
        label: candidate.label,
        hint: `connects ${candidate.toolkit} via OAuth`,
      })),
      {
        value: FREE_TEXT_TASK_ID,
        label: 'Something else…',
        hint: 'describe it and we will find the tools',
      },
    ]);

    if (choice !== FREE_TEXT_TASK_ID) {
      const curated = ONBOARD_TASKS.find(candidate => candidate.id === choice);
      return curated
        ? { task: curated, toolkit: curated.toolkit, query: curated.searchQuery }
        : undefined;
    }

    const text = yield* params.ui.text('What do you want to do?', {
      placeholder: 'e.g. "summarize my unread emails"',
    });
    return Option.isSome(text) ? selectionFromTaskText(text.value) : undefined;
  });

export interface OnboardDemo {
  readonly slug: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly kind: 'read' | 'reversible_create' | undefined;
  readonly summarize?: OnboardExecuteSummarizer;
}

export const resolveDemo = (params: {
  readonly task: OnboardTask | undefined;
  readonly searchSummary: ToolsSearchSummary | undefined;
  readonly connectedToolkits: ReadonlyArray<string>;
}): OnboardDemo | undefined => {
  const connected = new Set(params.connectedToolkits.map(toolkit => toolkit.toLowerCase()));
  const task =
    params.task && connected.has(params.task.toolkit)
      ? params.task
      : findOnboardTaskForConnectedToolkits(params.connectedToolkits);
  const firstSlug = params.searchSummary?.firstSlug;
  const firstToolkit = params.searchSummary?.firstToolkit?.toLowerCase();
  const searchDemo =
    firstSlug && (!firstToolkit || connected.has(firstToolkit))
      ? ({ slug: firstSlug, args: {}, kind: undefined } satisfies OnboardDemo)
      : undefined;

  if (task) {
    const hint = task.demo.toolSlugHint;
    const demoFromTask: OnboardDemo = {
      slug: hint,
      args: task.demo.sampleArgs,
      kind: task.demo.kind,
      summarize: task.demo.summarize,
    };
    const slugs = params.searchSummary?.slugs ?? [];
    if (slugs.length === 0 || slugs.includes(hint)) {
      return demoFromTask;
    }
    return searchDemo ?? demoFromTask;
  }
  return searchDemo;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const genericExecuteSummary = (data: Record<string, unknown>): string | undefined => {
  const d = { ...data, ...asRecord(data.data) };
  const login = str(d.login) ?? str(d.username);
  const idNum =
    typeof d.number === 'number' ? d.number : typeof d.id === 'number' ? d.id : undefined;
  const title = str(d.title) ?? str(d.name) ?? str(d.subject);
  const url = str(d.html_url) ?? str(d.url) ?? str(d.permalink);
  const parts: string[] = [];
  if (login) parts.push(`@${login}`);
  if (idNum !== undefined) parts.push(`#${idNum}`);
  if (title) parts.push(`'${title}'`);
  if (url) parts.push(`→ ${url}`);
  return parts.length > 0 ? parts.join(' ') : undefined;
};

const showExecuteSummary = (
  ui: TerminalUI,
  summarize: OnboardExecuteSummarizer | undefined,
  result: ToolExecuteResponse
) =>
  Effect.gen(function* () {
    const line =
      summarize?.(result.data) ?? genericExecuteSummary(result.data) ?? 'Execution successful';
    const suffix = result.logId ? ` (logId: ${result.logId})` : '';
    yield* ui.log.success(`${line}${suffix}`);
  });

const executeDemo = (params: {
  readonly ui: TerminalUI;
  readonly demo: OnboardDemo;
  readonly quiet: boolean;
}) =>
  runToolsExecute({
    slug: params.demo.slug,
    data: Option.some(JSON.stringify(params.demo.args)),
    file: Option.none(),
    account: Option.none(),
    userId: Option.none(),
    projectName: Option.none(),
    surface: 'root',
    projectMode: 'consumer',
    getSchema: false,
    dryRun: false,
    skipConnectionCheck: false,
    skipToolParamsCheck: false,
    skipChecks: false,
    quiet: params.quiet,
    onSuccess: params.quiet
      ? result => showExecuteSummary(params.ui, params.demo.summarize, result)
      : undefined,
  }).pipe(
    Effect.tapError(() =>
      params.ui.log.warn(
        'First run did not succeed — fix the inputs above and re-run `composio onboard` (it resumes at this step).'
      )
    )
  );

const demoKindLabel = (kind: OnboardDemo['kind']): string => {
  switch (kind) {
    case 'read':
      return 'read-only demo';
    case 'reversible_create':
      return 'creates something you can delete right after';
    default:
      return 'execute validates inputs and tells you what to fix';
  }
};

const offerFollowUpCreate = (params: {
  readonly ui: TerminalUI;
  readonly followUp: OnboardFollowUpCreate;
}) =>
  Effect.gen(function* () {
    const { ui, followUp } = params;
    const wants = yield* ui.confirm(`Want to try creating something? (${followUp.label})`, {
      defaultValue: false,
    });
    if (!wants) {
      yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_SKIPPED, 'create', { origin: 'prompt' });
      return;
    }

    yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_STARTED, 'create', {
      slug: followUp.toolSlugHint,
    });

    const args: Record<string, unknown> = { ...(followUp.fixedArgs ?? {}) };
    for (const arg of followUp.requiredArgs) {
      const value = yield* ui.text(arg.prompt, { placeholder: arg.placeholder });
      if (Option.isNone(value)) {
        yield* ui.log.info('No problem — you can create something later with `composio execute`.');
        yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_SKIPPED, 'create', {
          origin: 'missing_arg',
          arg: arg.key,
        });
        return;
      }
      args[arg.key] = value.value;
    }

    yield* ui.log.step(`Creating with ${followUp.toolSlugHint}…`);
    yield* runToolsExecute({
      slug: followUp.toolSlugHint,
      data: Option.some(JSON.stringify(args)),
      file: Option.none(),
      account: Option.none(),
      userId: Option.none(),
      projectName: Option.none(),
      surface: 'root',
      projectMode: 'consumer',
      getSchema: false,
      dryRun: false,
      skipConnectionCheck: false,
      skipToolParamsCheck: false,
      skipChecks: false,
      quiet: true,
      onSuccess: result => showExecuteSummary(ui, followUp.summarize, result),
    }).pipe(
      Effect.tap(() =>
        Effect.gen(function* () {
          yield* ui.log.info('Remember to close/archive it when you are done.');
          yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_COMPLETED, 'create', {
            slug: followUp.toolSlugHint,
          });
        })
      ),
      Effect.catchAll(error =>
        Effect.gen(function* () {
          yield* Effect.logDebug('Onboard follow-up create failed:', error);
          yield* ui.log.warn(
            'That create did not go through — check the error above and try `composio execute` when ready.'
          );
        })
      )
    );
  });

const runNonInteractiveOnboard = (params: {
  readonly ui: TerminalUI;
  readonly state: OnboardState;
  readonly invocationSkips: ReadonlyArray<OnboardSkippableStep>;
  readonly task: Option.Option<string>;
  readonly toolkit: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const { ui, state } = params;
    const connectSkipped = params.invocationSkips.includes('connect');
    const executeSkipped = params.invocationSkips.includes('execute');

    const selection = Option.isSome(params.toolkit)
      ? selectionFromToolkit(params.toolkit.value)
      : Option.isSome(params.task)
        ? selectionFromTaskText(params.task.value)
        : undefined;
    const connected = new Set(state.connectedToolkits.map(toolkit => toolkit.toLowerCase()));

    if (state.loggedIn && selection?.toolkit) {
      const target = selection.toolkit;
      if (!connected.has(target) && !connectSkipped && !state.connectionCheckFailed) {
        yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_STARTED, 'connect', {
          toolkit: target,
          task_id: selection.task?.id ?? FREE_TEXT_TASK_ID,
          mode: 'non_interactive',
        });
        return yield* runConnectedAccountsLink({
          toolkit: Option.some(target),
          authConfig: Option.none(),
          userId: Option.none(),
          projectName: Option.none(),
          noWait: true,
          noBrowser: true,
          alias: Option.none(),
          list: false,
          rootOnly: true,
        });
      }
      if (connected.has(target) && !executeSkipped && !state.hasExecuted) {
        const demo = resolveDemo({
          task: selection.task,
          searchSummary: undefined,
          connectedToolkits: [target],
        });
        if (demo) {
          yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_STARTED, 'execute', {
            slug: demo.slug,
            mode: 'non_interactive',
          });
          yield* executeDemo({ ui, demo, quiet: false });
          yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_COMPLETED, 'execute', {
            slug: demo.slug,
          });
          yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_COMPLETED);
          return;
        }
      }
    }

    const hint = yield* Effect.sync((): string | undefined => {
      if (selection?.toolkit && !connected.has(selection.toolkit) && state.connectionCheckFailed) {
        return `Couldn't verify whether "${selection.toolkit}" is connected. Re-run \`composio onboard\` once the Composio API is reachable.`;
      }
      if (Option.isSome(params.task) && !selection?.toolkit) {
        return `No curated task matched. Run \`composio search "${params.task.value}"\` to find a toolkit, then \`composio onboard --toolkit <slug>\`.`;
      }
      return undefined;
    });
    yield* ui.output(
      buildStateJson({
        state,
        invocationSkips: params.invocationSkips,
        hint,
      })
    );
  });

const runInteractiveOnboard = (params: {
  readonly ui: TerminalUI;
  readonly state: OnboardState;
  readonly invocationSkips: ReadonlyArray<OnboardSkippableStep>;
  readonly yes: boolean;
  readonly task: Option.Option<string>;
  readonly toolkit: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const { ui } = params;
    const connectSkipped = params.invocationSkips.includes('connect');
    const executeSkipped = params.invocationSkips.includes('execute');
    const loginNeeded = (state: OnboardState) =>
      resolveOnboard({ facts: state, invocationSkips: params.invocationSkips }).nextStep ===
      'login';

    yield* ui.intro('composio onboard');

    let state = params.state;

    if (loginNeeded(state)) {
      yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_STARTED, 'login');
      yield* ui.log.step('Log in to Composio');
      yield* browserLogin({
        scope: 'user',
        noBrowser: false,
        skipOrgProjectPicker: params.yes,
      });
      const ctx = yield* ComposioUserContext;
      if (!ctx.isLoggedIn()) {
        yield* ui.log.warn('Login did not complete.');
        yield* ui.outro('Re-run `composio onboard` to resume.');
        return;
      }
      yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_COMPLETED, 'login');
      state = yield* computeOnboardState;
    }

    if (!state.loggedIn) {
      yield* ui.outro(
        'Login was skipped — run `composio onboard` again without `--skip login` to continue.'
      );
      return;
    }

    const selection = yield* resolveInteractiveSelection({
      ui,
      toolkit: params.toolkit,
      task: params.task,
    });
    if (!selection) {
      yield* ui.outro(
        'No task selected. Re-run `composio onboard` anytime, or explore with `composio search "<what you want>"`.'
      );
      return;
    }
    const selectedTask = selection.task;
    let searchSummary: ToolsSearchSummary | undefined;
    let targetToolkit = selection.toolkit;

    if (!targetToolkit) {
      searchSummary = yield* runToolsSearch({
        query: [selection.query],
        toolkits: Option.none(),
        userId: Option.none(),
        projectName: Option.none(),
        limit: 5,
        json: false,
        human: true,
        rootOnly: true,
      }).pipe(
        Effect.catchAll(error =>
          Effect.logDebug('Onboard search failed:', error).pipe(
            Effect.as({
              firstSlug: undefined,
              firstToolkit: undefined,
              slugs: [],
            } satisfies ToolsSearchSummary)
          )
        )
      );
      targetToolkit = searchSummary?.firstToolkit?.toLowerCase();
      if (!targetToolkit) {
        yield* ui.log.warn('No tools found for that task.');
        yield* ui.outro(
          'Try `composio search "<phrase>"` to explore, then re-run `composio onboard`.'
        );
        return;
      }
    }

    const isConnected = () =>
      state.connectedToolkits.some(t => t.toLowerCase() === targetToolkit!.toLowerCase());

    if (!isConnected()) {
      if (connectSkipped) {
        yield* ui.outro(
          'Connecting an app was skipped — run `composio onboard` again without `--skip connect` to continue.'
        );
        return;
      }
      if (state.connectionCheckFailed) {
        yield* ui.outro(
          "Couldn't reach the Composio API to check your connections. Check your network and re-run `composio onboard`."
        );
        return;
      }
      yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_STARTED, 'connect', {
        toolkit: targetToolkit,
        task_id: selectedTask?.id ?? FREE_TEXT_TASK_ID,
      });
      yield* ui.log.step(`Connect ${targetToolkit} (opens your browser for OAuth)`);
      yield* runConnectedAccountsLink({
        toolkit: Option.some(targetToolkit),
        authConfig: Option.none(),
        userId: Option.none(),
        projectName: Option.none(),
        noWait: false,
        noBrowser: false,
        alias: Option.none(),
        list: false,
        rootOnly: true,
      });
      state = yield* computeOnboardState;
      if (!isConnected()) {
        yield* ui.log.warn(`No active connection for "${targetToolkit}" yet.`);
        yield* ui.outro('Finish authorizing in the browser, then re-run `composio onboard`.');
        return;
      }
      yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_COMPLETED, 'connect', {
        toolkit: targetToolkit,
      });
    } else {
      yield* ui.log.success(`${targetToolkit} already connected`);
    }

    if (executeSkipped) {
      yield* ui.outro(
        'Your first execution was skipped — run `composio onboard` again without `--skip execute` to finish.'
      );
      return;
    }

    const demoTask = selectedTask ?? findOnboardTaskByToolkit(targetToolkit);
    const demo = resolveDemo({
      task: demoTask,
      searchSummary,
      connectedToolkits: [targetToolkit],
    });
    if (!demo) {
      yield* ui.log.info(
        commandHintStep('Find something to run', 'root.search') +
          '\n' +
          commandHintStep('Then execute it', 'root.execute')
      );
      yield* ui.outro(
        'Almost there — your first successful `composio execute` completes onboarding.'
      );
      return;
    }

    yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_STARTED, 'execute', { slug: demo.slug });
    yield* ui.log.step(`Run your first tool: ${demo.slug} (${demoKindLabel(demo.kind)})`);
    const confirmed =
      params.yes || (yield* ui.confirm(`Run ${demo.slug} now?`, { defaultValue: true }));
    if (!confirmed) {
      yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_SKIPPED, 'execute', { origin: 'prompt' });
      yield* ui.outro(
        `No problem — run it anytime:\n> composio execute ${demo.slug} -d '${JSON.stringify(demo.args)}'`
      );
      return;
    }

    yield* executeDemo({ ui, demo, quiet: true });
    yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_COMPLETED, 'execute', { slug: demo.slug });
    yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_COMPLETED);
    yield* ui.log.success('Onboarding complete — you just ran your first Composio tool.');

    if (!params.yes && demoTask?.followUpCreate) {
      yield* offerFollowUpCreate({ ui, followUp: demoTask.followUpCreate });
    }

    yield* ui.log.info(
      [
        commandHintStep('Find more tools', 'root.search'),
        commandHintStep('Execute anything', 'root.execute'),
      ].join('\n')
    );
    yield* ui.outro("You're all set!");
  });

export const onboardCmd = Command.make(
  'onboard',
  { human, json, yes, task, toolkit: toolkitOpt, skip, status: statusOpt },
  ({ human, json, yes, task, toolkit, skip, status }) =>
    Effect.gen(function* () {
      const ui = yield* TerminalUI;
      const terminal = yield* ui.capabilities;
      const interactive = terminal.isInteractive;

      const invocationSkips: OnboardSkippableStep[] = [];
      for (const value of skip) {
        const normalized = value.trim().toLowerCase();
        if (!isOnboardSkippableStep(normalized)) {
          return yield* Effect.fail(
            invalidOptionValue(
              `Invalid --skip value "${value}". Expected one of: ${ONBOARD_SKIPPABLE_STEPS.join(', ')}.`
            )
          );
        }
        invocationSkips.push(normalized);
      }

      const emitHuman = human;
      const emitJson = json || !emitHuman;

      if (status) {
        const state = yield* computeOnboardState;
        yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STATUS_VIEWED, undefined, {
          complete: state.complete,
          next_step: state.nextStep ?? null,
          forced: true,
        });
        yield* emitStatus({
          ui,
          state,
          invocationSkips,
          emitHuman,
          emitJson,
          forceJson: json,
          withIntro: interactive,
        });
        return;
      }

      if (invocationSkips.length > 0) {
        const config = yield* ComposioCliUserConfig;
        const alreadySkipped = new Set(config.data.onboard.skippedSteps);
        const freshSkips = invocationSkips.filter(step => !alreadySkipped.has(step));
        yield* recordOnboardSkippedSteps(invocationSkips);
        yield* Effect.forEach(freshSkips, step =>
          track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STEP_SKIPPED, step, { origin: 'flag' })
        );
      }

      const state = yield* computeOnboardState;

      if (state.complete) {
        yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STATUS_VIEWED, undefined, {
          complete: true,
        });
        yield* emitStatus({
          ui,
          state,
          invocationSkips,
          emitHuman,
          emitJson,
          forceJson: json,
          withIntro: interactive,
        });
        return;
      }

      yield* track(CLI_ANALYTICS_EVENTS.CLI_ONBOARD_STARTED, undefined, {
        resume_step: state.nextStep ?? null,
        mode: interactive ? 'interactive' : 'non_interactive',
      });

      if (!interactive) {
        return yield* runNonInteractiveOnboard({
          ui,
          state,
          invocationSkips,
          task,
          toolkit,
        });
      }

      return yield* runInteractiveOnboard({
        ui,
        state,
        invocationSkips,
        yes,
        task,
        toolkit,
      });
    })
).pipe(
  Command.withDescription(
    [
      'Guided setup: log in, connect an app via OAuth, and run your first tool.',
      'State-driven and resumable — run it anytime; it continues where you left off',
      'and shows a status view once everything is set up.',
      '',
      'Examples:',
      '  composio onboard',
      '  composio onboard --status',
      '  composio onboard --toolkit github',
      '  composio onboard --task "read my gmail"',
      '  composio onboard --yes',
      '  composio onboard --skip execute',
      '',
      'Non-interactive (agents/pipes): never prompts; emits JSON describing the',
      'current state and the single next command to run.',
    ].join('\n')
  )
);
