// test-jobs-tui.mjs — verification for jobs-tui header, sort, and filter helpers.
import assert from 'node:assert/strict';
import { renderJobList, sortJobsByStatus, filterJobsByStatus } from './lib/jobs-tui.mjs';

const S = { bold: (s) => s, dim: (s) => s, green: (s) => s, red: (s) => s, yellow: (s) => s };

// 1. renderJobList emits a column header (below the JOBS title bar) with STATUS/MODEL/TASK
{
  const jobs = [
    { id: 'j1', status: 'running', model: 'm', mode: 'agentic', elapsedMs: 100, preview: 'hi' },
  ];
  const out = renderJobList(jobs, 0, S, 80, 'all');
  const lines = out.split('\n');
  assert.ok(lines[0].includes('JOBS'), 'title bar is first line');
  const headerLine = lines.find((l) => l.includes('STATUS') && l.includes('MODEL') && l.includes('TASK'));
  assert.ok(headerLine, 'column header present with STATUS/MODEL/TASK');
  console.log('check 1 (header) OK');
}

// 2. sortJobsByStatus places running/queued first
{
  const rows = [
    { id: 'a', status: 'completed' },
    { id: 'b', status: 'queued' },
    { id: 'c', status: 'failed' },
    { id: 'd', status: 'running' },
    { id: 'e', status: 'completed' },
  ];
  const sorted = sortJobsByStatus(rows);
  const statuses = sorted.map((r) => r.status);
  // running first, then queued, then the rest in original order
  assert.deepEqual(statuses, ['running', 'queued', 'completed', 'failed', 'completed']);
  console.log('check 2 (sort) OK');
}

// 3. filterJobsByStatus returns only matching statuses for all filter values
{
  const rows = [
    { id: 'a', status: 'running' },
    { id: 'b', status: 'queued' },
    { id: 'c', status: 'completed' },
    { id: 'd', status: 'failed' },
  ];
  const all = filterJobsByStatus(rows, 'all');
  assert.equal(all.length, 4, 'all returns everything');

  const running = filterJobsByStatus(rows, 'running');
  assert.deepEqual(running.map((r) => r.id), ['a', 'b'], 'running includes queued');

  const completed = filterJobsByStatus(rows, 'completed');
  assert.deepEqual(completed.map((r) => r.id), ['c'], 'completed only');

  const failed = filterJobsByStatus(rows, 'failed');
  assert.deepEqual(failed.map((r) => r.id), ['d'], 'failed only');

  // view-only: original array untouched
  assert.equal(rows.length, 4, 'original untouched');
  console.log('check 3 (filter) OK');
}

console.log('ALL TESTS OK');
