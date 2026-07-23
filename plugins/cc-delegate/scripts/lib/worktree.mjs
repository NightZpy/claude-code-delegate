// Isolated git worktree helper for delegating agentic writes without corrupting
// a shared working tree. ponytail: untracked files are intentionally not carried
// into the new worktree — only tracked changes are replicated.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Low‑level git helpers – zero shell, explicit cwd, no interpolation.
// ---------------------------------------------------------------------------

/** Execute git, return { stdout, stderr, code }. Never throws. */
async function gitNoThrow(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
    });
    return {
      stdout: stdout?.trim() || '',
      stderr: stderr?.trim() || '',
      code: 0,
    };
  } catch (err) {
    return {
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim(),
      code: err.code || 1,
    };
  }
}

/** Execute git, return trimmed stdout. Throws on non‑zero exit. */
async function git(cwd, args) {
  const { stdout, stderr, code } = await gitNoThrow(cwd, args);
  if (code !== 0) {
    const err = new Error(stderr || `git ${args[0]} failed`);
    err.code = code;
    err.stderr = stderr;
    throw err;
  }
  return stdout;
}

/** Execute git, return RAW (untrimmed) stdout — required for diffs, whose
 * trailing newline is significant (trimming it yields "corrupt patch"). */
async function gitRaw(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout || '';
  } catch (err) {
    const e = new Error(err.stderr?.trim() || `git ${args[0]} failed`);
    e.code = err.code || 1;
    e.stderr = err.stderr?.trim() || '';
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Conflict‑file parsing from `git apply --check` stderr
// ---------------------------------------------------------------------------

function parseConflictFiles(stderr) {
  const lines = stderr.split('\n').filter(Boolean);
  const files = new Set();

  for (const line of lines) {
    // "error: patch failed: path/to/file:lineno"
    const m1 = line.match(/patch failed:\s*(.+?):\d+$/);
    if (m1) {
      files.add(m1[1].trim());
      continue;
    }
    // "error: path/to/file: patch does not apply"
    const m2 = line.match(/error:\s*(.+?):\s*patch does not apply/);
    if (m2) {
      files.add(m2[1].trim());
    }
  }

  if (files.size > 0) return [...files];
  // Fallback: return raw stderr as the conflict description
  return [stderr];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an isolated worktree branched from repoDir's current HEAD, carrying
 * the repo's current tracked working changes into it. Untracked files are
 * intentionally NOT copied.
 *
 * @param {string} repoDir – absolute path to the main repository
 * @returns {Promise<{ dir: string, base: string, snapshotCommit: string, cleanup: () => Promise<void> }>}
 */
export async function createIsolatedWorktree(repoDir) {
  const absRepo = path.resolve(repoDir);
  const base = await git(absRepo, ['rev-parse', 'HEAD']);

  // Unique identifiers
  const hex = crypto.randomBytes(6).toString('hex');
  const worktreeDir = path.join(os.tmpdir(), `cc-delegate-wt-${hex}`);
  const branch = `cc-delegate/wt-${hex}`;
  let patchFilePath = null;

  // Create the worktree on a fresh branch at base
  await git(absRepo, ['worktree', 'add', '-b', branch, worktreeDir, base]);

  // Carry current tracked changes into the worktree, if any
  try {
    const currentPatch = await gitRaw(absRepo, ['diff', 'HEAD']);
    if (currentPatch.trim().length > 0) {
      patchFilePath = path.join(os.tmpdir(), `cc-delegate-wt-patch-${hex}.patch`);
      await fs.writeFile(patchFilePath, currentPatch.endsWith('\n') ? currentPatch : currentPatch + '\n', 'utf-8');
      await git(worktreeDir, ['apply', patchFilePath]);
    }

    // Commit the baseline inside the worktree so job changes are later
    // just "everything since the snapshot". A clean tree has nothing to
    // commit — git exits non-zero and prints "nothing to commit" to STDOUT
    // (not stderr), so detect the empty case explicitly instead of relying on
    // the commit error, and keep the snapshot at base.
    let snapshotCommit = base;
    await git(worktreeDir, ['add', '-A']);
    const { code: hasStaged } = await gitNoThrow(worktreeDir, ['diff', '--cached', '--quiet']);
    if (hasStaged !== 0) {
      await git(worktreeDir, [
        '-c',
        'user.email=cc-delegate@local',
        '-c',
        'user.name=cc-delegate',
        'commit',
        '-m',
        'cc-delegate snapshot',
        '--no-verify',
      ]);
      snapshotCommit = await git(worktreeDir, ['rev-parse', 'HEAD']);
    }

    // Build the cleanup closure before returning so the caller can reliably
    // tear everything down even when the above steps partially succeeded.
    const cleanup = async () => {
      // Remove the worktree (force)
      try {
        await git(absRepo, ['worktree', 'remove', '--force', worktreeDir]);
      } catch {
        /* best effort */
      }
      // Delete the temporary branch
      try {
        await git(absRepo, ['branch', '-D', branch]);
      } catch {
        /* best effort */
      }
      // Remove the temporary patch file if it was written
      if (patchFilePath) {
        try {
          await fs.unlink(patchFilePath);
        } catch {
          /* best effort */
        }
      }
    };

    return { dir: worktreeDir, base, snapshotCommit, cleanup };
  } catch (err) {
    // If anything fails after worktree creation, tear down to avoid leaks.
    try {
      await git(absRepo, ['worktree', 'remove', '--force', worktreeDir]);
    } catch {
      /* best effort */
    }
    try {
      await git(absRepo, ['branch', '-D', branch]);
    } catch {
      /* best effort */
    }
    if (patchFilePath) {
      try {
        await fs.unlink(patchFilePath);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
}

/**
 * Capture the job's OWN patch: everything changed in wt.dir since
 * wt.snapshotCommit, INCLUDING newly created (untracked) files. The worktree's
 * committed history is not mutated.
 *
 * @param {{ dir: string, snapshotCommit: string }} wt
 * @returns {Promise<string>} unified diff (may be empty)
 */
export async function captureJobPatch(wt) {
  // Stage everything so untracked files appear in the diff
  await git(wt.dir, ['add', '-A']);
  const patch = await gitRaw(wt.dir, ['diff', '--cached', wt.snapshotCommit]);

  // Reset the index (best effort, never throw)
  try {
    await git(wt.dir, ['reset']);
  } catch {
    // swallowing is intentional
  }

  return patch;
}

/**
 * Apply a job patch back onto repoDir's working tree. All‑or‑nothing: if
 * `git apply --check` fails, nothing is applied and the caller receives
 * conflict information. No auto‑3way‑merge is performed.
 *
 * @param {string} repoDir
 * @param {string} patch
 * @returns {Promise<{ applied: boolean, conflicts?: string[] }>}
 */
export async function mergePatchBack(repoDir, patch) {
  if (!patch || !patch.trim()) {
    return { applied: true };
  }

  const absRepo = path.resolve(repoDir);
  const hex = crypto.randomBytes(6).toString('hex');
  const patchFile = path.join(os.tmpdir(), `cc-merge-patch-${hex}.patch`);

  try {
    await fs.writeFile(patchFile, patch.endsWith('\n') ? patch : patch + '\n', 'utf-8');

    // Strict pre‑check – exit code tells us if it would succeed
    const { code, stderr } = await gitNoThrow(absRepo, [
      'apply',
      '--check',
      patchFile,
    ]);

    if (code === 0) {
      // Apply for real
      await git(absRepo, ['apply', patchFile]);
      return { applied: true };
    }

    // Check failed – collect conflict files from stderr
    const conflicts = parseConflictFiles(stderr);
    return { applied: false, conflicts };
  } finally {
    // Always clean up the temporary patch file
    try {
      await fs.unlink(patchFile);
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Self‑test (executed with `node lib/worktree.mjs --selftest`)
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const tmpBase = os.tmpdir();
    const repoDir = path.join(tmpBase, `cc-selftest-${crypto.randomBytes(6).toString('hex')}`);
    const worktrees = [];

    try {
      // 1. Create a fresh repository with initial commit
      await fs.mkdir(repoDir, { recursive: true });
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.email', 'test@selftest'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

      // a.txt = "one\n"
      await fs.writeFile(path.join(repoDir, 'a.txt'), 'one\n', 'utf-8');
      await git(repoDir, ['add', 'a.txt']);
      await git(repoDir, ['commit', '-m', 'initial']);

      // 2. Uncommitted tracked change in the repo (a.txt -> "one\ndirty\n")
      await fs.writeFile(path.join(repoDir, 'a.txt'), 'one\ndirty\n', 'utf-8');

      // 3. Create isolated worktree – should carry the dirty change
      const wt1 = await createIsolatedWorktree(repoDir);
      worktrees.push(wt1);

      // Check that worktree dir exists and a.txt carries "dirty"
      await fs.access(wt1.dir);
      const aContent = await fs.readFile(path.join(wt1.dir, 'a.txt'), 'utf-8');
      assert.strictEqual(aContent, 'one\ndirty\n', 'carried dirty change');

      // 4. In the worktree, edit a.txt -> append "job\n" and create b.txt
      await fs.appendFile(path.join(wt1.dir, 'a.txt'), 'job\n');
      await fs.writeFile(path.join(wt1.dir, 'b.txt'), 'new\n', 'utf-8');

      // 5. Capture job patch – must mention a.txt and b.txt
      const patch1 = await captureJobPatch(wt1);
      assert.ok(patch1.includes('a.txt'), 'patch mentions a.txt');
      assert.ok(patch1.includes('b.txt'), 'patch mentions b.txt');

      // 6. Merge patch back into repo – should succeed cleanly
      const result = await mergePatchBack(repoDir, patch1);
      assert.strictEqual(result.applied, true, 'merge applied');

      // Verify repo: a.txt ends with "job" and b.txt exists with "new"
      const repoA = await fs.readFile(path.join(repoDir, 'a.txt'), 'utf-8');
      assert.ok(repoA.endsWith('job\n'), 'repo a.txt ends with job');
      const repoB = await fs.readFile(path.join(repoDir, 'b.txt'), 'utf-8');
      assert.strictEqual(repoB, 'new\n', 'repo b.txt has new');

      // 7. Conflict scenario: second worktree changes a.txt conflictingly
      const wt2 = await createIsolatedWorktree(repoDir);
      worktrees.push(wt2);

      // In wt2, replace a.txt with conflicting content
      const wt2APath = path.join(wt2.dir, 'a.txt');
      await fs.writeFile(wt2APath, 'one\nconflict\njob\n', 'utf-8'); // adds a conflicting line
      const patchConflict = await captureJobPatch(wt2);

      // Meanwhile, modify repo's a.txt on the SAME line to cause a conflict
      const repoAPath = path.join(repoDir, 'a.txt');
      const origRepoA = await fs.readFile(repoAPath, 'utf-8');
      // Change "one\ndirty\njob\n" (current after merge) to "one\nchanged\njob\n"
      const changedRepoA = origRepoA.replace(/dirty/g, 'changed');
      await fs.writeFile(repoAPath, changedRepoA, 'utf-8');

      const conflictResult = await mergePatchBack(repoDir, patchConflict);
      assert.strictEqual(conflictResult.applied, false, 'conflict detected');
      assert.ok(
        conflictResult.conflicts && conflictResult.conflicts.length > 0,
        'non-empty conflicts array',
      );

      // Cleanup both worktrees
      for (const wt of worktrees) {
        await wt.cleanup();
      }

      // Final cleanup of the temp repository
      await fs.rm(repoDir, { recursive: true, force: true });

      console.log('SELFTEST OK');
      process.exit(0);
    } catch (err) {
      console.error('SELFTEST FAILED:', err);
      // Best-effort cleanup
      for (const wt of worktrees) {
        try {
          await wt.cleanup();
        } catch {
          /* ignore */
        }
      }
      try {
        await fs.rm(repoDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      process.exit(1);
    }
  })();
}
