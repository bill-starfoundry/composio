import { describe, expect, it } from '@effect/vitest';
import {
  findOnboardTaskByToolkit,
  findOnboardTaskForConnectedToolkits,
  FREE_TEXT_TASK_ID,
  matchOnboardTask,
  ONBOARD_TASKS,
} from 'src/services/onboard-tasks';

describe('ONBOARD_TASKS registry', () => {
  it('contains only managed-OAuth tasks', () => {
    for (const task of ONBOARD_TASKS) {
      expect(task.authType).toBe('oauth');
    }
  });

  it('declares a demo kind for every task', () => {
    for (const task of ONBOARD_TASKS) {
      expect(['read', 'reversible_create']).toContain(task.demo.kind);
      expect(task.demo.toolSlugHint.length).toBeGreaterThan(0);
      expect(task.demo.sampleArgs).toBeTypeOf('object');
    }
  });

  it('has unique ids and toolkits, none colliding with the free-text escape', () => {
    const ids = ONBOARD_TASKS.map(task => task.id);
    const toolkits = ONBOARD_TASKS.map(task => task.toolkit);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(toolkits).size).toBe(toolkits.length);
    expect(ids).not.toContain(FREE_TEXT_TASK_ID);
  });

  it('uses lowercase toolkit slugs', () => {
    for (const task of ONBOARD_TASKS) {
      expect(task.toolkit).toBe(task.toolkit.toLowerCase());
    }
  });
});

describe('findOnboardTaskByToolkit', () => {
  it('matches case-insensitively and trims', () => {
    expect(findOnboardTaskByToolkit('GitHub ')?.id).toBe('github_profile');
    expect(findOnboardTaskByToolkit('gmail')?.toolkit).toBe('gmail');
  });

  it('returns undefined for non-curated toolkits', () => {
    expect(findOnboardTaskByToolkit('salesforce')).toBeUndefined();
  });
});

describe('matchOnboardTask', () => {
  it('matches free text mentioning a curated toolkit', () => {
    expect(matchOnboardTask('read my Gmail inbox')?.toolkit).toBe('gmail');
    expect(matchOnboardTask('something with github please')?.toolkit).toBe('github');
  });

  it('returns undefined for unrelated text and empty input', () => {
    expect(matchOnboardTask('order a pizza')).toBeUndefined();
    expect(matchOnboardTask('   ')).toBeUndefined();
  });
});

describe('findOnboardTaskForConnectedToolkits', () => {
  it('picks the first curated task among connected toolkits', () => {
    expect(findOnboardTaskForConnectedToolkits(['slack', 'gmail'])?.toolkit).toBe('gmail');
    expect(findOnboardTaskForConnectedToolkits(['SLACK'])?.toolkit).toBe('slack');
  });

  it('returns undefined when nothing matches', () => {
    expect(findOnboardTaskForConnectedToolkits(['salesforce'])).toBeUndefined();
    expect(findOnboardTaskForConnectedToolkits([])).toBeUndefined();
  });
});
