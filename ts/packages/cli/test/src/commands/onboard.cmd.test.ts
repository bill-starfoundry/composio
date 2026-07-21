import { describe, expect, layer } from '@effect/vitest';
import { ConfigProvider, Effect } from 'effect';
import { HelpDoc, ValidationError } from '@effect/cli';
import { extendConfigProvider } from 'src/services/config';
import { ComposioUserContext } from 'src/services/user-context';
import { cli, TestLive, MockConsole } from 'test/__utils__';
import type { ConnectedAccountItem } from 'src/models/connected-accounts';

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

  layer(TestLive({ baseConfigProvider: loggedInConfigProvider }))('host wiring under --yes', it => {
    it.scoped('[Given] --yes and no persisted host skip [Then] host wiring runs', () =>
      Effect.gen(function* () {
        yield* loginTestOrg;
        yield* cli(['onboard', '--yes', '--toolkit', 'github']);
        const output = (yield* MockConsole.getLines({ stripAnsi: true })).join('\n');
        expect(output).toContain('Agent plugin');
      })
    );
  });

  layer(
    TestLive({
      baseConfigProvider: loggedInConfigProvider,
      cliUserConfig: { onboardSkippedSteps: ['host'] },
    })
  )('host wiring honors persisted skip non-interactively', it => {
    it.scoped('[Given] --yes and a persisted host skip [Then] host wiring is not attempted', () =>
      Effect.gen(function* () {
        yield* loginTestOrg;
        yield* cli(['onboard', '--yes', '--toolkit', 'github']);
        const output = (yield* MockConsole.getLines({ stripAnsi: true })).join('\n');
        expect(output).not.toContain('Agent plugin');
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
});
