import { describe, expect, layer } from '@effect/vitest';
import { ConfigProvider, Effect, Option } from 'effect';
import { HelpDoc, ValidationError } from '@effect/cli';
import { extendConfigProvider } from 'src/services/config';
import { ComposioUserContext } from 'src/services/user-context';
import { TerminalUI } from 'src/services/terminal-ui';
import { cli, TestLive, MockConsole } from 'test/__utils__';
import { terminalUITestImpl } from 'test/__utils__/services/terminal-ui-test';
import type { ConnectedAccountItem } from 'src/models/connected-accounts';

const interactiveUI = TerminalUI.of({
  ...terminalUITestImpl,
  capabilities: Effect.succeed({
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    isInteractive: true,
    canDecorate: true,
  }),
  confirm: () => Effect.succeed(true),
  text: () => Effect.succeed(Option.none()),
});

const loggedInConfigProvider = ConfigProvider.fromMap(
  new Map([['COMPOSIO_USER_API_KEY', 'test_api_key']])
).pipe(extendConfigProvider);

const gmailAccount: ConnectedAccountItem = {
  id: 'con_onboard_test',
  alias: 'default',
  word_id: 'castle',
  status: 'ACTIVE',
  status_reason: null,
  is_disabled: false,
  user_id: 'consumer-user-org_test',
  toolkit: { slug: 'gmail' },
  auth_config: {
    id: 'ac_gmail_oauth',
    auth_scheme: 'OAUTH2',
    is_composio_managed: true,
    is_disabled: false,
  },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-15T00:00:00Z',
  test_request_endpoint: '',
};

const extractStateJson = (output: string): Record<string, unknown> => {
  const candidates = output.match(/\{\n {2}"state"[\s\S]*?\n\}/g) ?? [];
  expect(candidates.length, `no state JSON found in output:\n${output}`).toBeGreaterThan(0);
  return JSON.parse(candidates[candidates.length - 1]) as Record<string, unknown>;
};

const loginTestOrg = Effect.gen(function* () {
  const userContext = yield* ComposioUserContext;
  yield* userContext.login('test_api_key', 'org_test');
});

describe('CLI: composio onboard (non-interactive contract)', () => {
  layer(TestLive())('logged out', it => {
    it.scoped('[Given] fresh install [Then] emits logged_out state with login as next step', () =>
      Effect.gen(function* () {
        yield* cli(['onboard']);
        const output = (yield* MockConsole.getLines()).join('\n');
        const state = extractStateJson(output);
        expect(state.state).toBe('logged_out');
        expect(state.completed).toEqual([]);
        expect(state.remaining).toEqual(['login', 'connect', 'execute']);
        expect(state.next).toEqual({ step: 'login', cmd: 'composio login' });
      })
    );
  });

  layer(TestLive({ baseConfigProvider: loggedInConfigProvider }))('no connections', it => {
    it.scoped('[Given] no connections [Then] next step is connect with a toolkit suggestion', () =>
      Effect.gen(function* () {
        yield* loginTestOrg;
        yield* cli(['onboard']);
        const output = (yield* MockConsole.getLines()).join('\n');
        const state = extractStateJson(output);
        expect(state.state).toBe('logged_in');
        expect(state.completed).toEqual(['login']);
        expect(state.remaining).toEqual(['connect', 'execute']);
        const next = state.next as { step: string; cmd: string };
        expect(next.step).toBe('connect');
        expect(next.cmd).toContain('composio onboard --toolkit');
      })
    );
  });

  layer(TestLive({ baseConfigProvider: loggedInConfigProvider }))('drives connect', it => {
    it.scoped('[Given] --toolkit [Then] drives the connect step via link --no-wait', () =>
      Effect.gen(function* () {
        yield* loginTestOrg;
        yield* cli(['onboard', '--toolkit', 'github']);
        const output = (yield* MockConsole.getLines()).join('\n');
        expect(output).toContain('"status": "pending"');
        expect(output).toContain('redirect_url');
        expect(output).toContain('"toolkit": "github"');
      })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: {
        items: [{ ...gmailAccount, id: 'con_gh', toolkit: { slug: 'github' } }],
      },
      toolsExecutor: {
        respondWith: {
          successful: true,
          data: { login: 'KJ-11', name: 'Kshitij Jhunjhunwala' },
          error: null,
          logId: 'log_demo',
        },
      },
      terminalUI: interactiveUI,
    })
  )('interactive human summary', it => {
    it.scoped(
      '[Given] connected + interactive menu [Then] shows a summary line, not raw JSON',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard']);
          const output = (yield* MockConsole.getLines({ stripAnsi: true })).join('\n');
          // menu picks the first curated task (github); it is connected, so acknowledge it
          expect(output).toContain('github already connected');
          // human summary from the demo's summarize(), not a raw JSON dump
          expect(output).toContain("You're @KJ-11 (Kshitij Jhunjhunwala)");
          expect(output).toContain('Onboarding complete');
          // the forced raw JSON result must NOT be emitted in interactive mode
          expect(output).not.toContain('"login"');
          expect(output).not.toContain('"successful"');
          // end-of-onboarding soft nudge to composio setup
          expect(output).toContain('composio setup');
        })
    );
  });

  const bigEmails = [
    { subject: 'Hello there', snippet: 'the quick brown fox jumps over the lazy dog '.repeat(40) },
    ...Array.from({ length: 200 }, (_, i) => ({
      subject: `Email ${i}`,
      snippet: 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(40),
    })),
  ];

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: { items: [gmailAccount] },
      toolsExecutor: {
        respondWith: {
          successful: true,
          data: { messages: bigEmails },
          error: null,
          logId: 'log_gmail',
        },
      },
      terminalUI: interactiveUI,
    })
  )('connected-first menu + no file spill', it => {
    it.scoped(
      '[Given] only gmail connected [Then] the menu picks gmail and a huge result never spills to a file',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard']);
          const output = (yield* MockConsole.getLines({ stripAnsi: true })).join('\n');
          // connected-first ordering: gmail (connected) is chosen over github (first in the registry)
          expect(output).toContain('gmail already connected');
          // gmail summarizer line
          expect(output).toContain("Fetched 201 emails (latest: 'Hello there')");
          // the large payload must NOT be written to a temp file
          expect(output).not.toContain('Response stored in');
          // and the raw snippet text must not be dumped
          expect(output).not.toContain('lorem ipsum');
        })
    );
  });

  layer(TestLive({ baseConfigProvider: loggedInConfigProvider }))('never wires hosts', it => {
    it.scoped('[Given] --yes [Then] onboard never touches agent plugins', () =>
      Effect.gen(function* () {
        yield* loginTestOrg;
        yield* cli(['onboard', '--yes', '--toolkit', 'github']);
        const output = (yield* MockConsole.getLines({ stripAnsi: true })).join('\n');
        expect(output).not.toContain('Agent plugin');
        expect(output).not.toContain('plugin');
        expect(output).toContain('"status": "pending"');
      })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: {
        items: [{ ...gmailAccount, id: 'con_gh', toolkit: { slug: 'github' } }],
      },
    })
  )('drives read, never offers create non-interactively', it => {
    it.scoped(
      '[Given] connected + --toolkit github [Then] runs the read demo and never prompts to create',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard', '--toolkit', 'github']);
          const output = (yield* MockConsole.getLines({ stripAnsi: true })).join('\n');
          expect(output).toContain('GITHUB_GET_THE_AUTHENTICATED_USER');
          expect(output).not.toContain('Want to try creating');
        })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: { items: [gmailAccount] },
    })
  )('named toolkit not connected routes to connect, never executes unlinked', it => {
    it.scoped(
      '[Given] gmail connected + --toolkit github [Then] connects github, never runs a github tool',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard', '--toolkit', 'github']);
          const output = (yield* MockConsole.getLines({ stripAnsi: true })).join('\n');
          // routes to connect the named (unconnected) toolkit
          expect(output).toContain('"status": "pending"');
          expect(output).toContain('"toolkit": "github"');
          // must NOT execute a github tool against an unlinked account
          expect(output).not.toContain('GITHUB_GET_THE_AUTHENTICATED_USER');
        })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: { items: [gmailAccount] },
    })
  )('connected, not executed', it => {
    it.scoped(
      '[Given] a connection [Then] next step is execute pointing at the connected app',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard']);
          const output = (yield* MockConsole.getLines()).join('\n');
          const state = extractStateJson(output);
          expect(state.state).toBe('connected');
          expect(state.completed).toEqual(['login', 'connect']);
          expect(state.remaining).toEqual(['execute']);
          expect(state.connections).toMatchObject({ count: 1, toolkits: ['gmail'] });
          expect(state.next).toEqual({
            step: 'execute',
            cmd: 'composio onboard --toolkit gmail',
          });
        })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: { items: [gmailAccount] },
      cliUserConfig: { onboardHasExecuted: true },
    })
  )('complete', it => {
    it.scoped('[Given] all gates satisfied [Then] collapses to a status view and exits 0', () =>
      Effect.gen(function* () {
        yield* loginTestOrg;
        yield* cli(['onboard']);
        const output = (yield* MockConsole.getLines()).join('\n');
        const state = extractStateJson(output);
        expect(state.state).toBe('complete');
        expect(state.remaining).toEqual([]);
        expect(state.next).toBeNull();
      })
    );

    it.scoped('[Given] --status [Then] shows the same status view', () =>
      Effect.gen(function* () {
        yield* loginTestOrg;
        yield* cli(['onboard', '--status']);
        const output = (yield* MockConsole.getLines()).join('\n');
        const state = extractStateJson(output);
        expect(state.state).toBe('complete');
      })
    );
  });

  layer(TestLive())('validation', it => {
    it.scoped('[Given] an invalid --skip value [Then] fails with an actionable message', () =>
      Effect.gen(function* () {
        const result = yield* cli(['onboard', '--skip', 'nonsense']).pipe(
          Effect.catchAll(error => Effect.succeed(error))
        );
        expect(ValidationError.isValidationError(result)).toBe(true);
        const message = HelpDoc.toAnsiText((result as ValidationError.ValidationError).error);
        expect(message).toContain('Invalid --skip value');
      })
    );
  });

  layer(TestLive({ baseConfigProvider: loggedInConfigProvider }))('skips', it => {
    it.scoped('[Given] --skip connect [Then] nothing is actionable and skip is recorded', () =>
      Effect.gen(function* () {
        yield* loginTestOrg;
        yield* cli(['onboard', '--skip', 'connect']);
        const output = (yield* MockConsole.getLines()).join('\n');
        const state = extractStateJson(output);
        expect(state.state).toBe('logged_in');
        expect(state.skipped).toEqual(['connect']);
        expect(state.next).toBeNull();
      })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      cliUserConfig: { onboardSkippedSteps: ['connect'] },
    })
  )('persisted connect skip is a record, not a block', it => {
    it.scoped(
      '[Given] persisted connect skip + bare run [Then] connect is not both skipped and next',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard']);
          const output = (yield* MockConsole.getLines()).join('\n');
          const state = extractStateJson(output);
          // persisted skips are a record, not a block: connect is still the next step
          expect(state.skipped).toEqual([]);
          expect(state.persisted_skips).toEqual(['connect']);
          const next = state.next as { step: string } | null;
          expect(next?.step).toBe('connect');
          // the contradiction is gone: connect never appears in both skipped and next/remaining
          expect(state.skipped).not.toContain('connect');
        })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: {
        items: [{ ...gmailAccount, id: 'con_sf', toolkit: { slug: 'salesforce' } }],
      },
    })
  )('execute-gate next never recommends a non-curated toolkit', it => {
    it.scoped(
      '[Given] only a non-curated connection [Then] next recommends a progressing command',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard']);
          const output = (yield* MockConsole.getLines()).join('\n');
          const state = extractStateJson(output);
          expect(state.state).toBe('connected');
          const next = state.next as { step: string; cmd: string };
          expect(next.step).toBe('execute');
          // must NOT loop by suggesting --toolkit for the non-curated toolkit
          expect(next.cmd).not.toContain('salesforce');
          expect(next.cmd).not.toContain('--toolkit');
          expect(next.cmd).toContain('composio search');
        })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: {
        items: [
          { ...gmailAccount, id: 'con_sf', toolkit: { slug: 'salesforce' } },
          { ...gmailAccount, id: 'con_gh', toolkit: { slug: 'github' } },
        ],
      },
    })
  )('execute-gate next prefers a curated connected toolkit', it => {
    it.scoped(
      '[Given] a curated connection among non-curated ones [Then] next targets the curated one',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard']);
          const output = (yield* MockConsole.getLines()).join('\n');
          const state = extractStateJson(output);
          const next = state.next as { step: string; cmd: string };
          expect(next.step).toBe('execute');
          expect(next.cmd).toBe('composio onboard --toolkit github');
        })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      cliUserConfig: { onboardHasExecuted: true },
      connectedAccountsData: { listShouldFail: true },
    })
  )('failed connection check with prior completion', it => {
    it.scoped(
      '[Given] a transient API failure + prior has_executed [Then] stays complete, never reconnect',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard']);
          const output = (yield* MockConsole.getLines()).join('\n');
          const state = extractStateJson(output);
          expect(state.state).toBe('complete');
          expect(state.next).toBeNull();
          expect(state.connections).toMatchObject({ check_failed: true });
          // must not push a completed user back into connect/OAuth
          expect(output).not.toContain('"step": "connect"');
        })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: { listShouldFail: true },
    })
  )('failed connection check without prior evidence', it => {
    it.scoped(
      '[Given] a transient API failure + no prior completion [Then] signals failure, does not route to connect',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard']);
          const output = (yield* MockConsole.getLines()).join('\n');
          const state = extractStateJson(output);
          expect(state.connections).toMatchObject({ check_failed: true });
          expect(state.next).toBeNull();
          const next = state.next as { step: string } | null;
          expect(next?.step).not.toBe('connect');
          // an unknown connection is never listed as actionable/skipped
          expect(state.remaining).not.toContain('connect');
          expect(state.remaining).not.toContain('execute');
          expect(state.skipped).not.toContain('connect');
          expect(state.skipped).not.toContain('execute');
          expect(output).not.toContain('were skipped');
        })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      connectedAccountsData: { listShouldFail: true },
    })
  )('status view on a failed connection check', it => {
    it.scoped(
      '[Given] --status + a transient API failure [Then] the outro reports the API failure, not a skip',
      () =>
        Effect.gen(function* () {
          yield* loginTestOrg;
          yield* cli(['onboard', '--status']);
          const output = (yield* MockConsole.getLines()).join('\n');
          expect(output).toContain("Couldn't reach the Composio API");
          expect(output).not.toContain('were skipped');
        })
    );
  });
});
