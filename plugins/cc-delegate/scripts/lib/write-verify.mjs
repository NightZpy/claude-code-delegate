// Module: write-verify.mjs - ground AI agent file edit claims against real git diffs

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export function extractClaimedFiles(text) {
  const regex = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,5}\b/g;
  const candidates = text.match(regex) || [];
  const seen = new Set();
  const result = [];

  for (let token of candidates) {
    // Strip surrounding backticks, quotes, parens, commas
    token = token.replace(/^[`"'(\[,]+/, '').replace(/[`"')\],]+$/, '');

    // Strip leading ./
    if (token.startsWith('./')) {
      token = token.slice(2);
    }

    // Reject empty after stripping
    if (!token) continue;

    // Reject tokens that are purely numeric or dotted-numeric (e.g. 1.2.3, 0.16)
    if (/^\d+(\.\d+)*$/.test(token)) continue;

    // Reject tokens that start with a digit AND have no slash (e.g. "1file.py")
    if (/^\d/.test(token) && !token.includes('/')) continue;

    // Reject tokens ending with a dot
    if (token.endsWith('.')) continue;

    // Reject tokens with whitespace
    if (/\s/.test(token)) continue;

    // Reject tokens whose extension is longer than 5 chars
    const dotIndex = token.lastIndexOf('.');
    if (dotIndex >= 0 && token.slice(dotIndex + 1).length > 5) continue;

    // Deduplicate
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }

  return result;
}

export function reconcileClaims(text, touchedFiles) {
  const claimed = extractClaimedFiles(text);
  const notApplied = [];

  for (const claimedFile of claimed) {
    let matched = false;
    for (const touched of touchedFiles) {
      // Suffix tolerance both ways: claimed suffix matches touched OR touched suffix matches claimed
      if (claimedFile.endsWith(touched) || touched.endsWith(claimedFile)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      notApplied.push(claimedFile);
    }
  }

  return { claimed, notApplied };
}

export async function diffOfFiles(cwd, files) {
  if (!files || files.length === 0) return '';

  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'diff', 'HEAD', '--', ...files], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8'
    });
    return stdout;
  } catch {
    return '';
  }
}

// Self-test
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--selftest')) {
  let failed = false;

  try {
    // Test 1
    const result1 = extractClaimedFiles("I edited `src/api/routes.ts` and lib/util.mjs, bumped to 1.2.3");
    assert.ok(result1.includes('src/api/routes.ts'), 'Should include src/api/routes.ts');
    assert.ok(result1.includes('lib/util.mjs'), 'Should include lib/util.mjs');
    assert.ok(!result1.includes('1.2.3'), 'Should not include 1.2.3');
  } catch (e) {
    console.error('Test 1 failed:', e.message);
    failed = true;
  }

  try {
    // Test 2
    const result2 = extractClaimedFiles("see ./worker.py (updated)");
    assert.ok(result2.includes('worker.py'), 'Should include worker.py (leading ./ stripped)');
  } catch (e) {
    console.error('Test 2 failed:', e.message);
    failed = true;
  }

  try {
    // Test 3
    const result3 = reconcileClaims("edited src/a.ts and src/b.ts", ["src/a.ts"]);
    assert.deepStrictEqual(result3.notApplied, ["src/b.ts"], 'notApplied should be ["src/b.ts"]');
  } catch (e) {
    console.error('Test 3 failed:', e.message);
    failed = true;
  }

  try {
    // Test 4
    const result4 = reconcileClaims("edited routes.ts", ["src/api/routes.ts"]);
    assert.deepStrictEqual(result4.notApplied, [], 'notApplied should be empty');
  } catch (e) {
    console.error('Test 4 failed:', e.message);
    failed = true;
  }

  try {
    // Test 5
    const result5 = reconcileClaims("edited src/api/routes.ts", ["routes.ts"]);
    assert.deepStrictEqual(result5.notApplied, [], 'notApplied should be empty');
  } catch (e) {
    console.error('Test 5 failed:', e.message);
    failed = true;
  }

  try {
    // Test 6
    const result6 = await diffOfFiles("/nonexistent-dir-xyz", ["a.ts"]);
    assert.strictEqual(result6, '', 'Should return empty string on error');
  } catch (e) {
    console.error('Test 6 failed:', e.message);
    failed = true;
  }

  try {
    // Test 7
    const result7 = await diffOfFiles(process.cwd(), []);
    assert.strictEqual(result7, '', 'Should return empty string for empty files');
  } catch (e) {
    console.error('Test 7 failed:', e.message);
    failed = true;
  }

  if (failed) {
    console.error('SELFTEST FAILED');
    process.exit(1);
  } else {
    console.log('SELFTEST OK');
    process.exit(0);
  }
}
