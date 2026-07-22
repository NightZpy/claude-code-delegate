// Self-contained orchestrator for delegated coding tasks — zero deps, pure control flow, all I/O injected.
import assert from 'node:assert';

export async function runOrchestration(opts) {
  const {
    tasks: givenTasks,
    brief,
    repoDir,
    workerModel,
    orchestratorModel,
    maxConcurrent = 1,
    deps,
  } = opts;

  // 1. Resolve task list
  let tasks;
  let planCostUsd = 0;

  if (Array.isArray(givenTasks) && givenTasks.length > 0) {
    tasks = givenTasks;
  } else if (brief) {
    const raw = await deps.planTasks(brief, orchestratorModel);
    if (Array.isArray(raw)) {
      tasks = raw;
      planCostUsd = raw.reduce((sum, t) => sum + (t.costUsd ?? 0), 0); // unlikely but absorb
    } else if (raw && Array.isArray(raw.tasks)) {
      tasks = raw.tasks;
      planCostUsd = raw.costUsd ?? 0;
    } else {
      throw new Error('orchestrate: planTasks returned unexpected format');
    }
  } else {
    throw new Error('orchestrate: provide tasks or brief');
  }

  // 2. Normalize tasks
  const normed = tasks.map((task, idx) => {
    const id = task.id || `task-${idx + 1}`;
    const title = task.title || (task.brief || '').slice(0, 60);
    const model = task.model || workerModel;
    return { ...task, id, title, model };
  });

  let orchestratorUsd = planCostUsd;
  let workersUsd = 0;

  const results = [];
  const requiresSeniorReview = [];

  // ponytail: sequential v1; maxConcurrent reserved for a future per-worker-server parallel version
  for (const task of normed) {
    let currentResult = {
      id: task.id,
      title: task.title,
      model: task.model,
      status: 'unknown',
      patch: '',
      evidence: '',
      review: null,
    };

    try {
      if (typeof deps.log === 'function') {
        deps.log(`▶ ${task.id} — ${task.title}`);
      }

      // 4a run worker
      const w = await deps.runWorker(
        { id: task.id, title: task.title, brief: task.brief, model: task.model },
        repoDir
      );
      workersUsd += w.costUsd ?? 0;

      if (!w.ok) {
        currentResult.status = 'failed';
        currentResult.patch = w.patch ?? '';
        currentResult.evidence = w.evidence ?? '';
        requiresSeniorReview.push({ id: task.id, title: task.title, reason: 'worker failed' });
        results.push(currentResult);
        continue;
      }

      const patch = w.patch ?? '';
      if (!patch.trim()) {
        // empty patch – no change, nothing to review or merge
        currentResult.status = 'empty';
        currentResult.patch = patch;
        currentResult.evidence = w.evidence ?? '';
        results.push(currentResult);
        continue;
      }

      currentResult.patch = patch;
      currentResult.evidence = w.evidence ?? '';

      // 4e review
      const review = await deps.reviewResult(
        { task: { id: task.id, title: task.title, brief: task.brief }, patch, evidence: w.evidence },
        orchestratorModel
      );
      orchestratorUsd += review.costUsd ?? 0;
      currentResult.review = review;

      if (review.verdict === 'pass') {
        // 4f merge
        const m = await deps.mergePatchBack(repoDir, patch);
        if (m.applied) {
          currentResult.status = 'merged';
        } else {
          currentResult.status = 'conflict';
          const conflictReason = 'merge conflict: ' + (m.conflicts || []).join(', ');
          requiresSeniorReview.push({ id: task.id, title: task.title, reason: conflictReason });
        }
      } else {
        // fail or unsure
        currentResult.status = 'flagged';
        const reason = 'review ' + review.verdict;
        requiresSeniorReview.push({ id: task.id, title: task.title, reason });
      }
    } catch (err) {
      // catch any error during task processing
      currentResult.status = 'failed';
      requiresSeniorReview.push({ id: task.id, title: task.title, reason: `error: ${err.message}` });
    }

    results.push(currentResult);
  }

  // 5. Build report
  const grouped = {
    merged: [],
    conflicts: [],
    failed: [],
    flagged: [],
    empty: [],
  };
  // status value 'conflict' maps to the plural report field 'conflicts'
  const statusToGroup = { merged: 'merged', conflict: 'conflicts', failed: 'failed', flagged: 'flagged', empty: 'empty' };
  for (const r of results) {
    const g = statusToGroup[r.status];
    if (g) {
      grouped[g].push(r.id);
    }
  }

  return {
    tasks: results,
    merged: grouped.merged,
    conflicts: grouped.conflicts,
    failed: grouped.failed,
    flagged: grouped.flagged,
    empty: grouped.empty,
    requiresSeniorReview,
    cost: {
      orchestratorUsd,
      workersUsd,
      totalUsd: orchestratorUsd + workersUsd,
    },
  };
}

// -------------------------------------------------------------------
// Self-test
// -------------------------------------------------------------------
if (
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` &&
  process.argv.includes('--selftest')
) {
  (async () => {
    const repoDir = '/fake/repo';

    // helper to create a deps factory for scenarios
    function makeDeps(overrides = {}) {
      const log = overrides.log ?? (() => {});
      return {
        planTasks: overrides.planTasks ?? (async () => []),
        runWorker: overrides.runWorker ?? (async () => ({ ok: false })),
        reviewResult: overrides.reviewResult ?? (async () => ({ verdict: 'fail', findings: [] })),
        mergePatchBack: overrides.mergePatchBack ?? (async () => ({ applied: false })),
        log,
      };
    }

    // Test 1: two happy tasks
    {
      const tasks = [
        { brief: 'add x', model: 'm1' },
        { brief: 'add y', model: 'm2' },
      ];
      const deps = makeDeps();
      deps.runWorker = async () => ({ ok: true, patch: 'diff', evidence: 'ev', costUsd: 0.01 });
      deps.reviewResult = async () => ({ verdict: 'pass', findings: [], costUsd: 0.005 });
      deps.mergePatchBack = async () => ({ applied: true });

      const report = await runOrchestration({
        tasks,
        repoDir,
        workerModel: 'w',
        orchestratorModel: 'o',
        deps,
      });

      assert.deepStrictEqual(report.merged, ['task-1', 'task-2']);
      assert.deepStrictEqual(report.requiresSeniorReview, []);
      assert.ok(Math.abs(report.cost.workersUsd - 0.02) < 0.0001);
      assert.ok(Math.abs(report.cost.orchestratorUsd - 0.01) < 0.0001);
      assert.ok(Math.abs(report.cost.totalUsd - 0.03) < 0.0001);
    }

    // Test 2: review fail
    {
      const tasks = [{ brief: 'a' }];
      const deps = makeDeps();
      deps.runWorker = async () => ({ ok: true, patch: 'diff', evidence: '' });
      deps.reviewResult = async () => ({ verdict: 'fail', findings: ['bad'] });
      deps.mergePatchBack = async () => ({ applied: false });

      const report = await runOrchestration({
        tasks,
        repoDir,
        workerModel: 'w',
        orchestratorModel: 'o',
        deps,
      });
      assert.deepStrictEqual(report.flagged, ['task-1']);
      assert.strictEqual(report.merged.length, 0);
      assert.strictEqual(report.requiresSeniorReview.length, 1);
      assert.strictEqual(report.requiresSeniorReview[0].reason, 'review fail');
    }

    // Test 3: merge conflict
    {
      const tasks = [{ brief: 'b' }];
      const deps = makeDeps();
      deps.runWorker = async () => ({ ok: true, patch: 'diff', evidence: '' });
      deps.reviewResult = async () => ({ verdict: 'pass', findings: [] });
      deps.mergePatchBack = async () => ({ applied: false, conflicts: ['x.ts'] });

      const report = await runOrchestration({
        tasks,
        repoDir,
        workerModel: 'w',
        orchestratorModel: 'o',
        deps,
      });
      assert.deepStrictEqual(report.conflicts, ['task-1']);
      assert.strictEqual(report.requiresSeniorReview.length, 1);
      assert.ok(report.requiresSeniorReview[0].reason.includes('x.ts'));
    }

    // Test 4: worker failed (ok:false)
    {
      const tasks = [{ brief: 'c' }];
      const deps = makeDeps();
      deps.runWorker = async () => ({ ok: false, patch: '', evidence: 'error' });

      const report = await runOrchestration({
        tasks,
        repoDir,
        workerModel: 'w',
        orchestratorModel: 'o',
        deps,
      });
      assert.deepStrictEqual(report.failed, ['task-1']);
      assert.strictEqual(report.requiresSeniorReview.length, 1);
      assert.strictEqual(report.requiresSeniorReview[0].reason, 'worker failed');
    }

    // Test 5: worker throws
    {
      const tasks = [{ brief: 'd' }, { brief: 'e' }];
      let callCount = 0;
      const deps = makeDeps();
      deps.runWorker = async () => {
        callCount++;
        if (callCount === 1) throw new Error('boom');
        return { ok: true, patch: 'diff', evidence: '', costUsd: 0 };
      };
      deps.reviewResult = async () => ({ verdict: 'pass', findings: [] });
      deps.mergePatchBack = async () => ({ applied: true });

      const report = await runOrchestration({
        tasks,
        repoDir,
        workerModel: 'w',
        orchestratorModel: 'o',
        deps,
      });
      assert.deepStrictEqual(report.failed, ['task-1']);
      assert.deepStrictEqual(report.merged, ['task-2']);
      assert.strictEqual(report.requiresSeniorReview[0].reason, 'error: boom');
    }

    // Test 6: brief path
    {
      const brief = 'big task to decompose';
      const deps = makeDeps();
      deps.planTasks = async () => ({
        tasks: [{ brief: 'sub1' }, { brief: 'sub2' }],
        costUsd: 0.002,
      });
      deps.runWorker = async () => ({ ok: true, patch: 'diff', evidence: '', costUsd: 0.01 });
      deps.reviewResult = async () => ({ verdict: 'pass', findings: [], costUsd: 0.005 });
      deps.mergePatchBack = async () => ({ applied: true });

      const report = await runOrchestration({
        brief,
        repoDir,
        workerModel: 'w',
        orchestratorModel: 'o',
        deps,
      });

      assert.strictEqual(report.tasks.length, 2);
      assert.strictEqual(report.tasks[0].id, 'task-1');
      assert.strictEqual(report.tasks[1].id, 'task-2');
      // orchestratorUsd includes planTasks 0.002 + two reviews 0.005 each = 0.012
      assert.ok(Math.abs(report.cost.orchestratorUsd - 0.012) < 0.0001);
      assert.ok(Math.abs(report.cost.workersUsd - 0.02) < 0.0001);
      assert.deepStrictEqual(report.merged, ['task-1', 'task-2']);
      assert.strictEqual(report.requiresSeniorReview.length, 0);
    }

    console.log('SELFTEST OK');
    process.exit(0);
  })().catch(err => {
    console.error('SELFTEST FAIL', err);
    process.exit(1);
  });
}
