/**
 * Curated starter tasks for `composio onboard`.
 *
 * Every curated task targets a Composio managed-OAuth toolkit (one browser
 * click to connect — the CLI never handles API keys). Each task declares
 * whether its demo action is a `read` or a `reversible_create` so the
 * onboarding flow can label the first execution honestly. The demo tool is
 * resolved through `composio search` at runtime; `toolSlugHint` is only a
 * preference among the search results, so a stale hint degrades gracefully.
 */

export type OnboardDemoKind = 'read' | 'reversible_create';

export interface OnboardTaskDemo {
  readonly kind: OnboardDemoKind;
  /** Preferred tool slug; used when the search results include it. */
  readonly toolSlugHint: string;
  /** Arguments that make the demo executable without user-specific input. */
  readonly sampleArgs: Readonly<Record<string, unknown>>;
}

export interface OnboardTask {
  readonly id: string;
  readonly label: string;
  readonly toolkit: string;
  readonly authType: 'oauth';
  readonly searchQuery: string;
  readonly demo: OnboardTaskDemo;
}

/** Menu id for the free-text escape hatch (not a curated task). */
export const FREE_TEXT_TASK_ID = 'free_text';

/**
 * Curated, OAuth-only starter tasks. Order is the static menu order
 * (most broadly connected toolkits first); there is no live popularity
 * signal available to the CLI, so the order is fixed.
 */
export const ONBOARD_TASKS: ReadonlyArray<OnboardTask> = [
  {
    id: 'github_profile',
    label: 'GitHub — fetch my profile',
    toolkit: 'github',
    authType: 'oauth',
    searchQuery: 'get my github profile',
    demo: {
      kind: 'read',
      toolSlugHint: 'GITHUB_GET_THE_AUTHENTICATED_USER',
      sampleArgs: {},
    },
  },
  {
    id: 'gmail_read_latest',
    label: 'Gmail — read my latest emails',
    toolkit: 'gmail',
    authType: 'oauth',
    searchQuery: 'read my latest emails',
    demo: {
      kind: 'read',
      toolSlugHint: 'GMAIL_FETCH_EMAILS',
      sampleArgs: { max_results: 5 },
    },
  },
  {
    id: 'slack_list_channels',
    label: 'Slack — list my channels',
    toolkit: 'slack',
    authType: 'oauth',
    searchQuery: 'list slack channels',
    demo: {
      kind: 'read',
      toolSlugHint: 'SLACK_LIST_ALL_CHANNELS',
      sampleArgs: { limit: 10 },
    },
  },
  {
    id: 'linear_my_issues',
    label: 'Linear — list my issues',
    toolkit: 'linear',
    authType: 'oauth',
    searchQuery: 'list my linear issues',
    demo: {
      kind: 'read',
      toolSlugHint: 'LINEAR_LIST_LINEAR_ISSUES',
      sampleArgs: {},
    },
  },
  {
    id: 'notion_search_pages',
    label: 'Notion — search my pages',
    toolkit: 'notion',
    authType: 'oauth',
    searchQuery: 'search notion pages',
    demo: {
      kind: 'read',
      toolSlugHint: 'NOTION_SEARCH_NOTION_PAGE',
      sampleArgs: { query: '' },
    },
  },
];

const normalizeToolkit = (slug: string): string => slug.trim().toLowerCase();

/** Find the curated task for a toolkit slug, if one exists. */
export const findOnboardTaskByToolkit = (toolkitSlug: string): OnboardTask | undefined =>
  ONBOARD_TASKS.find(task => task.toolkit === normalizeToolkit(toolkitSlug));

/**
 * Match free text against the curated tasks (by toolkit name appearing in
 * the phrase). Returns `undefined` when nothing matches — the caller then
 * treats the text as a free-text search query.
 */
export const matchOnboardTask = (text: string): OnboardTask | undefined => {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return ONBOARD_TASKS.find(task => normalized.includes(task.toolkit));
};

/** First curated task whose toolkit appears in the given connected toolkits. */
export const findOnboardTaskForConnectedToolkits = (
  connectedToolkits: ReadonlyArray<string>
): OnboardTask | undefined => {
  const connected = new Set(connectedToolkits.map(normalizeToolkit));
  return ONBOARD_TASKS.find(task => connected.has(task.toolkit));
};
