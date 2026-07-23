// Agentic parallel: Runs N bounded coding tasks concurrently in isolated worktrees via OpenCode sessions.
import { strict as assert } from 'node:assert';

// ponytail: isolation is via session directory + worktree, never chdir

/**
 * @param {object} opts
 * @param {Array<{id:string, title:string, brief:string, model:{providerID:string,modelID:string}, timeoutMs:number}>} opts.tasks
 * @param {string} opts.repoDir
 * @param {object} opts.deps - dependency injection
 * @returns {Promise<Array<{id:string, title:string, ok:boolean, patch:string, evidence:string, cost:number, error:string|null}>>}
 */
export async function runAgenticWorkersParallel(opts) {
  const { tasks, repoDir, deps } = opts;
  if (!tasks.length) return [];

  const server = await deps.ensureServer(deps.stateDir);

  const taskPromises = tasks.map(task => runOneTask(task, repoDir, server, deps));
  return await Promise.all(taskPromises);
}

async function runOneTask(task, repoDir, server, deps) {
  deps.log?.('▶ ' + task.id + ' — ' + task.title);

  let wt;
  try {
    wt = await deps.createIsolatedWorktree(repoDir);
  } catch (err) {
    return {
      id: task.id,
      title: task.title,
      ok: false,
      patch: '',
      evidence: '',
      cost: 0,
      usage: { input: 0, output: 0, reasoning: 0 },
      error: 'worktree: ' + err.message,
    };
  }

  let result;
  try {
    const sess = await deps.createSession(server, { directory: wt.dir });

    const resp = await deps.sendMessage(server, sess.id, {
      text: task.brief,
      agent: 'cc-build',
      model: task.model,
      timeoutMs: task.timeoutMs,
    });

    const ocErr = resp?.info?.error;
    let ok, error, evidence;
    if (ocErr) {
      ok = false;
      error = ocErr?.data?.message || ocErr?.message || JSON.stringify(ocErr);
      evidence = error;
    } else {
      const { text, toolCalls } = deps.extractText(resp);
      if (!text && !toolCalls) {
        ok = false;
        error = 'empty response';
        evidence = '';
      } else {
        ok = true;
        error = null;
        evidence = text;
      }
    }

    // best-effort cost + token capture (tokens needed so the caller can record
    // an accurate ledger row per worker).
    let cost = 0;
    let usage = { input: 0, output: 0, reasoning: 0 };
    try {
      const msgs = await deps.listMessages(server, sess.id);
      const u = deps.sumSessionUsage(msgs) || {};
      cost = u.cost || 0;
      usage = { input: u.input || 0, output: u.output || 0, reasoning: u.reasoning || 0 };
    } catch { /* noop */ }

    // best-effort patch capture, only on success
    let patch = '';
    if (ok) {
      try {
        patch = await deps.captureJobPatch(wt);
      } catch { /* noop */ }
    }

    result = {
      id: task.id,
      title: task.title,
      ok,
      patch,
      evidence,
      cost,
      usage,
      error: ok ? null : error,
    };
  } catch (err) {
    // unexpected internal failure – still cleanup
    result = {
      id: task.id,
      title: task.title,
      ok: false,
      patch: '',
      evidence: '',
      cost: 0,
      usage: { input: 0, output: 0, reasoning: 0 },
      error: err.message,
    };
  } finally {
    try {
      await wt.cleanup();
    } catch { /* cleanup must never throw */ }
  }

  return result;
}

// -----------------------------------------------------------------------------------
// Self-test (only when executed directly with --selftest)
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--selftest')) {
  // ----------- helpers -----------
  const makeBaseDeps = () => {
    let wtCounter = 0;
    let cleanupCount = 0;
    let ensureServerCalls = 0;
    let sessionCalls = 0;
    const server = {};

    // default success behaviors (overridable via patches)
    const deps = {
      stateDir: 'mock-state',
      log: () => {},
      ensureServer: async () => { ensureServerCalls++; return server; },
      createSession: async (srv, { directory }) => {
        sessionCalls++;
        return { id: `session-${directory}`, directory };
      },
      sendMessage: async () => ({ info: {} }),
      extractText: () => ({ text: 'ok', toolCalls: 1 }),
      listMessages: async () => [],
      sumSessionUsage: () => ({ cost: 0.01 }),
      createIsolatedWorktree: async () => {
        const dir = `worktree-${++wtCounter}`;
        const wt = {
          dir,
          base: 'base',
          snapshotCommit: 'abc',
          cleanup: () => { cleanupCount++; }, // sync is fine
        };
        return wt;
      },
      captureJobPatch: async (wt) => `diff-${wt.dir}`,
    };

    // expose stats
    return {
      deps,
      stats: () => ({ ensureServerCalls, sessionCalls, cleanupCount, wtCounter }),
    };
  };

  // ----------- tests -----------
  async function runAllTests() {
    // Test 1: two tasks, both succeed
    {
      const { deps, stats } = makeBaseDeps();
      const tasks = [
        { id: '1', title: 'Task 1', brief: 'do a', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 1000 },
        { id: '2', title: 'Task 2', brief: 'do b', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 1000 },
      ];
      const res = await runAgenticWorkersParallel({ tasks, repoDir: '/repo', deps });
      assert.equal(res.length, 2);
      const U0 = { input: 0, output: 0, reasoning: 0 };
      assert.deepStrictEqual(res[0], { id: '1', title: 'Task 1', ok: true, patch: 'diff-worktree-1', evidence: 'ok', cost: 0.01, usage: U0, error: null });
      assert.deepStrictEqual(res[1], { id: '2', title: 'Task 2', ok: true, patch: 'diff-worktree-2', evidence: 'ok', cost: 0.01, usage: U0, error: null });
      const s = stats();
      assert.equal(s.ensureServerCalls, 1, 'ensureServer should be called exactly once');
      assert.equal(s.cleanupCount, 2, 'both worktrees should be cleaned up');
    }

    // Test 2: one task fails with provider error, other succeeds
    {
      const { deps, stats } = makeBaseDeps();
      // override sendMessage to inject error for session of worktree-1 (first task)
      const origSend = deps.sendMessage;
      deps.sendMessage = async (srv, sid, opts) => {
        if (sid === 'session-worktree-1') {
          return { info: { error: { data: { message: 'insufficient balance' } } } };
        }
        return origSend(srv, sid, opts);
      };
      const tasks = [
        { id: 'a', title: 'Task A', brief: 'do x', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 500 },
        { id: 'b', title: 'Task B', brief: 'do y', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 500 },
      ];
      const res = await runAgenticWorkersParallel({ tasks, repoDir: '/repo', deps });
      assert.equal(res.length, 2);
      // first task failure
      const r0 = res[0];
      assert.equal(r0.id, 'a');
      assert.strictEqual(r0.ok, false);
      assert.ok(r0.error.includes('insufficient balance'), 'error should mention balance');
      assert.strictEqual(r0.patch, '');
      assert.strictEqual(r0.cost, 0.01, 'failed run may still have cost');
      // second task success
      const r1 = res[1];
      assert.strictEqual(r1.ok, true);
      assert.strictEqual(r1.patch, 'diff-worktree-2');
      assert.strictEqual(r1.cost, 0.01);
      assert.strictEqual(r1.error, null);
      // server called once
      assert.equal(stats().ensureServerCalls, 1);
      // both worktrees cleaned up
      assert.equal(stats().cleanupCount, 2);
    }

    // Test 3: createIsolatedWorktree throws for first task, second succeeds
    {
      const { deps, stats } = makeBaseDeps();
      let callIdx = 0;
      deps.createIsolatedWorktree = async () => {
        callIdx++;
        if (callIdx === 1) {
          throw new Error('no space left on device');
        }
        return {
          dir: `worktree-${callIdx}`,
          base: 'base',
          snapshotCommit: 'abc',
          cleanup: () => {}, // cleanup still tracked? we'll track manually via a separate counter
        };
      };
      // We need to track cleanup calls for the one that succeeded;
      // we'll patch cleanup to increment stats. Simple: we'll use a separate cleanupCount.
      let cleanCount2 = 0;
      const origCreateWT = deps.createIsolatedWorktree;
      deps.createIsolatedWorktree = async () => {
        const wt = await origCreateWT(); // but this throws for first call; we must replace entirely
        // This won't work because we need to override thoroughly.
        // Better: write a fully custom implementation inside this test block.
      };
      // Easier: redefine deps.createIsolatedWorktree from scratch in this test, using a local counter.
      let wtCounter = 0;
      let cleanupCount = 0;
      deps.createIsolatedWorktree = async () => {
        wtCounter++;
        if (wtCounter === 1) throw new Error('no space left on device');
        const dir = `worktree-${wtCounter}`;
        return { dir, base: 'base', snapshotCommit: 'abc', cleanup: () => { cleanupCount++; } };
      };
      // keep other deps unchanged

      const tasks = [
        { id: 'x', title: 'Task X', brief: 'do z', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 500 },
        { id: 'y', title: 'Task Y', brief: 'do w', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 500 },
      ];
      const res = await runAgenticWorkersParallel({ tasks, repoDir: '/repo', deps });
      assert.equal(res.length, 2);
      // first failure
      assert.deepStrictEqual(res[0], {
        id: 'x', title: 'Task X', ok: false, patch: '', evidence: '', cost: 0,
        usage: { input: 0, output: 0, reasoning: 0 },
        error: 'worktree: no space left on device',
      });
      // second success
      assert.strictEqual(res[1].ok, true);
      assert.strictEqual(res[1].patch, 'diff-worktree-2');
      assert.strictEqual(res[1].cost, 0.01);
      assert.strictEqual(res[1].error, null);
      // stats: ensureServer once
      const s = stats();
      assert.equal(s.ensureServerCalls, 1);
      // cleanup only for the second task
      assert.equal(cleanupCount, 1, 'only the second worktree should be cleaned up');
    }

    // Test 4: empty response (no text, no toolCalls) triggers failure
    {
      const { deps } = makeBaseDeps();
      deps.extractText = () => ({ text: '', toolCalls: 0 });
      const tasks = [
        { id: 'e1', title: 'Empty 1', brief: 'do', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 500 },
        { id: 'e2', title: 'Empty 2', brief: 'do', model: { providerID: 'p', modelID: 'm' }, timeoutMs: 500 },
      ];
      const res = await runAgenticWorkersParallel({ tasks, repoDir: '/repo', deps });
      assert.equal(res.length, 2);
      for (const r of res) {
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'empty response');
        assert.strictEqual(r.patch, '');
        assert.strictEqual(r.cost, 0.01, 'cost still captured even on empty response');
        assert.strictEqual(r.evidence, '');
      }
    }

    // Test 5: cleanup is called for every worktree that was successfully created
    // Covered by the above tests, but we explicitly verify:
    //   Test 1: all 2 worktrees cleaned up
    //   Test 2: both cleaned up (even though one task failed)
    //   Test 3: only the second cleaned up (first threw before creation)
    // We've already asserted cleanupCount in each.
    // Also verify that ensureServer is called exactly once across all tasks in each run.
    // Those assertions are already in place.
    console.log('SELFTEST OK');
    process.exit(0);
  }

  runAllTests().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
