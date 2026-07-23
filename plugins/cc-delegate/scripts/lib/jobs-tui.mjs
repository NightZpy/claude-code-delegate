// lib/jobs-tui.mjs — Interactive terminal panel for browsing delegated Claude Code jobs.
// Allows a user to watch running jobs without spending the orchestrator's context.
import { fileURLToPath } from 'node:url';

// ---------- pure helpers ----------

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

// Stable sort: running first, then queued, then everything else.
// Within each group the input (recency) order is preserved — Array.prototype.sort
// is stable in modern Node, so returning 0 keeps original positions.
export function sortJobsByStatus(jobs) {
  const rank = (j) => {
    if (j.status === 'running') return 0;
    if (j.status === 'queued') return 1;
    return 2;
  };
  return jobs.slice().sort((a, b) => rank(a) - rank(b));
}

// VIEW-only filter for the list panel. 'running' includes queued (treated as running).
export function filterJobsByStatus(jobs, filter) {
  if (!filter || filter === 'all') return jobs.slice();
  return jobs.filter((j) => {
    if (filter === 'running') return j.status === 'running' || j.status === 'queued';
    if (filter === 'completed') return j.status === 'completed';
    if (filter === 'failed') return j.status === 'failed';
    return true;
  });
}

// ---------- exported renderers ----------

/**
 * @param {Array<{id:string, status:string, model:string, mode:string, elapsedMs:number, preview:string}>} jobs
 * @param {number} selected
 * @param {{bold:(s:string)=>string, dim:(s:string)=>string, green:(s:string)=>string, red:(s:string)=>string, yellow:(s:string)=>string}} styles
 * @param {number} cols terminal width
 * @returns {string}
 */
export function renderJobList(jobs, selected, styles, cols, filter) {
  const lines = [];
  // Title/hint bar first, then the column header, then rows. The header is not
  // selectable (selection indexes the jobs array, not the rendered lines).
  const hint = filter
    ? `JOBS  (↑/↓ select · enter open · r reload · f filter: ${filter} · q quit)`
    : 'JOBS  (↑/↓ select · enter open · r reload · q quit)';
  lines.push(styles.dim(hint));
  const header = styles.dim(
    `  ${'STATUS'.padEnd(10)} ${'ID'.padEnd(22)} ${'MODEL'.padEnd(14)} ${'MODE'.padEnd(8)} ELAPSED TASK`,
  );
  lines.push(header);
  if (!jobs.length) {
    lines.push(styles.dim('no jobs yet'));
    return lines.join('\n');
  }

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const marker = i === selected ? '> ' : '  ';

    // pad status to exactly 10 visible chars then colour
    const paddedStatus = (job.status || '').padEnd(10).slice(0, 10);
    let statusStr;
    switch (job.status) {
      case 'running':
      case 'queued':
        statusStr = styles.yellow(paddedStatus);
        break;
      case 'completed':
        statusStr = styles.green(paddedStatus);
        break;
      case 'failed':
      case 'cancelled':
        statusStr = styles.red(paddedStatus);
        break;
      default:
        statusStr = paddedStatus;
    }

    const rawId = (job.id || '').slice(0, 22).padEnd(22);
    const rawModel = (job.model || '').padEnd(14).slice(0, 14);
    const rawMode = (job.mode || '').padEnd(8).slice(0, 8);
    const elapsedStr = formatElapsed(job.elapsedMs || 0).padEnd(7);
    let previewRaw = (job.preview || '').replace(/\n/g, ' ');

    // calculate visible width of the fixed parts (without any escape codes)
    const fixedVisible = marker.length + paddedStatus.length + 1 +
                         rawId.length + 1 +
                         rawModel.length + 1 +
                         rawMode.length + 1 +
                         elapsedStr.length + 1;  // space before preview
    const previewMax = Math.max(0, cols - fixedVisible);
    previewRaw = previewRaw.slice(0, previewMax);

    const hasPreview = previewMax > 0;
    const previewSegment = hasPreview ? ` ${previewRaw}` : '';

    let line = `${marker}${statusStr} ${rawId} ${rawModel} ${rawMode} ${elapsedStr}${previewSegment}`;
    if (i === selected) {
      line = styles.bold(line);
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * @param {{id:string, status:string, model:string, mode:string, elapsedMs:number, error?:string}} job
 * @param {string[]} activity
 * @param {string} logTail
 * @param {{bold, dim, green, red, yellow}} styles
 * @param {number} cols
 * @returns {string}
 */
export function renderJobDetail(job, activity, logTail, styles, cols) {
  const lines = [];

  // header – job id
  lines.push(styles.bold(`JOB ${job.id}`));

  // status line: status · model · mode · elapsed
  const elapsedStr = formatElapsed(job.elapsedMs || 0);
  const plainStatusLine = `${job.status} · ${job.model || ''} · ${job.mode || ''} · ${elapsedStr}`;
  // truncate visible text first
  let visibleStatusLine = plainStatusLine.slice(0, cols);

  // find where the status part ends (before the first " · ")
  const statusSeparatorIdx = visibleStatusLine.indexOf(' · ');
  const rawStatusPart = statusSeparatorIdx === -1 ? visibleStatusLine : visibleStatusLine.slice(0, statusSeparatorIdx);
  const restOfLine = statusSeparatorIdx === -1 ? '' : visibleStatusLine.slice(statusSeparatorIdx);

  let statusColored;
  switch (job.status) {
    case 'running':
    case 'queued':
      statusColored = styles.yellow(rawStatusPart);
      break;
    case 'completed':
      statusColored = styles.green(rawStatusPart);
      break;
    case 'failed':
    case 'cancelled':
      statusColored = styles.red(rawStatusPart);
      break;
    default:
      statusColored = rawStatusPart;
  }

  lines.push(styles.dim(statusColored + restOfLine));

  // error
  if (job.error) {
    const plainError = `error: ${job.error}`;
    lines.push(styles.red(plainError.slice(0, cols)));
  }

  // ACTIVITY section
  lines.push(styles.bold('ACTIVITY'));
  if (!activity || activity.length === 0) {
    lines.push(styles.dim('  (no tool activity yet)'));
  } else {
    for (const line of activity) {
      lines.push(`  ${line}`.slice(0, cols));
    }
  }

  // LOG section (last 20 lines)
  lines.push(styles.bold('LOG'));
  const logLines = logTail ? logTail.split('\n').filter((l) => l !== '') : [];
  const tail20 = logLines.slice(-20);
  if (tail20.length === 0) {
    lines.push(styles.dim('  (no log output yet)'));
  } else {
    for (const line of tail20) {
      lines.push(`  ${line}`.slice(0, cols));
    }
  }

  // footer
  const footer = '←/esc back · r reload · q quit';
  lines.push(styles.dim(footer.slice(0, cols)));

  return lines.join('\n');
}

// ---------- interactive loop ----------

export async function runJobsTui(deps) {
  const { listJobs, getDetail, stdin, stdout, styles, intervalMs = 1500 } = deps;
  let mode = 'list';
  let selected = 0;
  let currentJobId = null;
  let jobs = [];
  let filter = 'all'; // cycles: all → running → completed → failed → all
  const FILTER_CYCLE = ['all', 'running', 'completed', 'failed'];
  let detailData = null; // { job, activity, logTail }
  let cols = stdout.columns || 100;
  let rawModeEnabled = false;
  let intervalHandle = null;
  let dataListener = null;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (intervalHandle) clearInterval(intervalHandle);
    if (dataListener) stdin.removeListener('data', dataListener);
    if (rawModeEnabled && stdin.isTTY && stdin.setRawMode) {
      try { stdin.setRawMode(false); } catch (_) {}
    }
    stdin.pause();
  };

  const getViewJobs = () => filterJobsByStatus(jobs, filter);

  const render = () => {
    cols = stdout.columns || 100;
    let view;
    if (mode === 'list') {
      view = renderJobList(getViewJobs(), selected, styles, cols, filter);
    } else {
      view = detailData
        ? renderJobDetail(detailData.job, detailData.activity, detailData.logTail, styles, cols)
        : '';
    }
    stdout.write('\x1b[2J\x1b[H');
    stdout.write(view);
    stdout.write('\n');
  };

  const refresh = async () => {
    try {
      if (mode === 'list') {
        jobs = await listJobs();
        const viewJobs = getViewJobs();
        if (selected >= viewJobs.length) selected = Math.max(0, viewJobs.length - 1);
      } else {
        if (currentJobId) {
          detailData = await getDetail(currentJobId);
        }
      }
    } catch (_) {
      // keep previous data on transient errors
    }
    render();
  };

  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });

  const handleKey = (key) => {
    if (key === 'q' || key === '\x03') {
      cleanup();
      resolvePromise();
      return;
    }
    if (key === 'r') {
      refresh();  // fire-and-forget
      return;
    }

    if (mode === 'list') {
      if (key === '\x1b[A') {
        const viewJobs = getViewJobs();
        selected = Math.max(0, selected - 1);
        if (selected >= viewJobs.length) selected = Math.max(0, viewJobs.length - 1);
        render();
      } else if (key === '\x1b[B') {
        const viewJobs = getViewJobs();
        selected = Math.max(0, Math.min(viewJobs.length - 1, selected + 1));
        render();
      } else if (key === 'f') {
        const idx = FILTER_CYCLE.indexOf(filter);
        filter = FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length];
        const viewJobs = getViewJobs();
        selected = viewJobs.length > 0 ? Math.max(0, Math.min(selected, viewJobs.length - 1)) : 0;
        render();
      } else if (key === '\r' || key === '\n') {
        const viewJobs = getViewJobs();
        if (viewJobs.length > 0 && selected >= 0 && selected < viewJobs.length) {
          currentJobId = viewJobs[selected].id;
          mode = 'detail';
          refresh();
        }
      }
    } else {
      // detail mode
      if (key === '\x1b[D' || key === '\x1b') {
        mode = 'list';
        currentJobId = null;
        refresh();
      }
    }
  };

  dataListener = (data) => {
    let i = 0;
    while (i < data.length) {
      const char = data[i];
      if (char === '\x1b') {
        if (data.substring(i, i + 3) === '\x1b[A') {
          handleKey('\x1b[A');
          i += 3;
        } else if (data.substring(i, i + 3) === '\x1b[B') {
          handleKey('\x1b[B');
          i += 3;
        } else if (data.substring(i, i + 3) === '\x1b[D') {
          handleKey('\x1b[D');
          i += 3;
        } else {
          handleKey('\x1b');
          i += 1;
        }
      } else {
        handleKey(char);
        i += 1;
      }
    }
  };

  stdin.on('data', dataListener);

  if (stdin.isTTY && stdin.setRawMode) {
    stdin.setRawMode(true);
    rawModeEnabled = true;
  }
  stdin.resume();
  stdin.setEncoding('utf8');

  // initial fetch & render
  await refresh();
  intervalHandle = setInterval(refresh, intervalMs);

  return promise;
}

// ---------- self-test (run with --selftest) ----------
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--selftest')) {
  (async () => {
    const assert = await import('node:assert');
    const S = { bold: (s) => s, dim: (s) => s, green: (s) => s, red: (s) => s, yellow: (s) => s };

    // 1. empty list
    const out1 = renderJobList([], 0, S, 80);
    assert.ok(out1.includes('no jobs yet'), 'Test 1: empty list message');

    // 2. two jobs, second selected (line 0 = hint/title, line 1 = header, line 2+ = jobs)
    const jobs2 = [
      { id: 'job-1', status: 'running', model: 'gpt-4', mode: 'agentic', elapsedMs: 500, preview: 'doing work' },
      { id: 'job-2-long-id-123456789012345', status: 'completed', model: 'claude-3', mode: 'react', elapsedMs: 125000, preview: 'finished' }
    ];
    const out2 = renderJobList(jobs2, 1, S, 80);
    const lines2 = out2.split('\n');
    assert.ok(lines2[0].includes('JOBS'), 'Title bar first');
    assert.ok(lines2[1].includes('STATUS') && lines2[1].includes('MODEL') && lines2[1].includes('TASK'), 'Header row second');
    assert.ok(lines2[2].startsWith('  '), 'Job 0 row starts with two spaces');
    assert.ok(lines2[3].startsWith('> '), 'Job 1 row starts with > ');
    assert.ok(lines2[2].includes('job-1'), 'Job 0 row contains job-1');
    // ids are truncated to 22 chars, so the row carries the truncated prefix
    assert.ok(lines2[3].includes('job-2-long-id-123456789012345'.slice(0, 22)), 'Job 1 row contains truncated id');

    // 3. long preview – all lines <= cols
    const longPreview = 'x'.repeat(500);
    const jobsLong = [{ id: 'j', status: 'queued', model: 'm', mode: 'm', elapsedMs: 0, preview: longPreview }];
    const outLong = renderJobList(jobsLong, 0, S, 80);
    for (const line of outLong.split('\n')) {
      assert.ok(line.length <= 80, `Line length ${line.length} > 80`);
    }

    // 4. detail with empty activity/log
    const job4 = { id: 'j1', status: 'running', model: 'm', mode: 'agentic', elapsedMs: 1500 };
    const out4 = renderJobDetail(job4, [], '', S, 80);
    assert.ok(out4.includes('(no tool activity yet)'), 'Detail empty activity');
    assert.ok(out4.includes('(no log output yet)'), 'Detail empty log');

    // 5. detail with activity and 30 log lines → only last 20 appear
    const activity5 = ['read a.ts', 'edit b.ts'];
    const logLines5 = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const logTail5 = logLines5.join('\n') + '\n';
    const out5 = renderJobDetail(job4, activity5, logTail5, S, 80);
    assert.ok(out5.includes('read a.ts'), 'Activity line present');
    assert.ok(out5.includes('edit b.ts'), 'Activity line present');
    // exact-line check: "line1" is a substring of "line11".."line19", which DO appear
    assert.ok(!out5.split('\n').some((l) => l.trim() === 'line1'), 'First log lines truncated');
    assert.ok(out5.includes('line11'), '11th log line present');
    assert.ok(out5.includes('line30'), '30th log line present');

    // 6. detail with error
    const job6 = { id: 'j2', status: 'failed', model: 'm', mode: 'm', elapsedMs: 500, error: 'boom' };
    const out6 = renderJobDetail(job6, [], '', S, 80);
    assert.ok(out6.includes('error: boom'), 'Error shown');

    console.log('SELFTEST OK');
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
