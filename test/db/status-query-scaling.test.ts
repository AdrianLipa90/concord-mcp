import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';

const baseTask = {
  title: 'Task',
  owner: null,
  agent: 'codex',
  branch: null,
  worktree: null,
  expectedFiles: [] as string[],
  modules: [] as string[],
  domains: [] as string[],
  riskTags: [] as string[],
  notes: null,
  parentTaskId: null,
  agentId: null,
};

const baseReview = {
  planSummary: 'plan',
  testsRun: [] as string[],
  diffSize: null,
  guardrailsChecked: [] as string[],
  assumptions: [] as string[],
  openQuestions: [] as string[],
  provenance: [],
};

describe('status query scaling repositories', () => {
  it('lists only requested task statuses while preserving task order', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    repos.tasks.create({ ...baseTask, taskId: 'ACTIVE', status: 'active' });
    repos.tasks.create({ ...baseTask, taskId: 'DONE', status: 'complete' });
    repos.tasks.create({ ...baseTask, taskId: 'REVIEW', status: 'review_ready' });

    expect(repos.tasks.listByStatuses(['active', 'review_ready']).map((task) => task.taskId)).toEqual([
      'ACTIVE',
      'REVIEW',
    ]);
    expect(repos.tasks.listByStatuses([])).toEqual([]);
  });

  it('loads the latest review for multiple tasks in one repository call', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    repos.tasks.create({ ...baseTask, taskId: 'A', status: 'review_ready' });
    repos.tasks.create({ ...baseTask, taskId: 'B', status: 'review_ready' });

    repos.reviews.create({ ...baseReview, taskId: 'A', planSummary: 'A old' });
    repos.reviews.create({ ...baseReview, taskId: 'B', planSummary: 'B latest' });
    repos.reviews.create({ ...baseReview, taskId: 'A', planSummary: 'A latest' });

    const latest = repos.reviews.latestForTasks(['A', 'B']);
    expect(latest.map((review) => [review.taskId, review.planSummary])).toEqual([
      ['A', 'A latest'],
      ['B', 'B latest'],
    ]);
    expect(repos.reviews.latestForTasks([])).toEqual([]);
  });
});
