#!/usr/bin/env node
/**
 * Bump the WebBrain version across every file that carries it.
 *
 *   node scripts/bump-version.mjs              # patch:  7.0.0 → 7.0.1
 *   node scripts/bump-version.mjs patch        # explicit patch
 *   node scripts/bump-version.mjs minor        # 7.0.0 → 7.1.0
 *   node scripts/bump-version.mjs major        # 7.0.0 → 8.0.0
 *   node scripts/bump-version.mjs 7.2.3        # set to an explicit version
 *
 * Or via npm:  npm run bump  ·  npm run bump -- minor  ·  npm run bump -- 7.2.3
 *
 * Updates (in lockstep):
 *   package.json              "version"
 *   package-lock.json         top-level "version" + packages[""].version
 *   manifest.json             "version"     (Chrome MV3, repo root)
 *   src/chrome/manifest.json  "version"     (Chrome MV3, in-source)
 *   src/firefox/manifest.json "version"     (Firefox MV2)
 *
 * Does NOT commit, push, or rebuild zips — just edits files. The script
 * prints the suggested next steps when it finishes so the operator can
 * decide whether to ship.
 *
 * The pure helper `bumpSemver(current, kind)` is exported for unit tests
 * — the CLI side of the script is guarded by an `import.meta.url` check
 * so importing this file doesn't trigger filesystem writes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// ─── Pure helper (exported for tests) ────────────────────────────────────

/**
 * Compute the next version from a current version + bump kind.
 *
 *   bumpSemver('7.0.0', 'patch')  → '7.0.1'
 *   bumpSemver('7.0.0', 'minor')  → '7.1.0'
 *   bumpSemver('7.0.0', 'major')  → '8.0.0'
 *   bumpSemver('7.0.0', '7.2.3')  → '7.2.3'   (explicit override)
 *
 * Accepts plain MAJOR.MINOR.PATCH only — no pre-release / build tags.
 * Throws on a malformed input so the operator sees a clear failure
 * instead of writing nonsense like "NaN.0.0" into the manifests.
 */
export function bumpSemver(current, kind = 'patch') {
  const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`Current version is not MAJOR.MINOR.PATCH: ${current}`);
  const [major, minor, patch] = match.slice(1, 4).map((n) => parseInt(n, 10));

  // Explicit-version override: anything that itself looks like semver.
  if (SEMVER.test(kind)) return kind;

  switch (kind) {
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'major': return `${major + 1}.0.0`;
    default:
      throw new Error(
        `Unknown bump kind: "${kind}". Expected one of: patch, minor, major, or an explicit MAJOR.MINOR.PATCH version.`
      );
  }
}

/**
 * In-place version replacement on a JSON file. Edits the textual JSON
 * (not the parsed object) so trailing whitespace, key order, and any
 * stylistic quirks in the file are preserved bit-for-bit. Only the FIRST
 * occurrence is changed unless `replaceAll` is set — relevant for
 * package-lock.json, which carries the version twice.
 *
 * Returns the new file content so the caller can audit / decide whether
 * to write it.
 */
export function rewriteVersionInJsonText(text, oldVersion, newVersion, { replaceAll = false } = {}) {
  // Match: `  "version": "<oldVersion>"` exactly, in any indentation.
  // The negative-lookbehind isn't supported everywhere — instead, anchor
  // on the JSON-property pattern and require the value to match oldVersion.
  const escapedOld = oldVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`("version"\\s*:\\s*")${escapedOld}(")`, replaceAll ? 'g' : '');
  return text.replace(pattern, `$1${newVersion}$2`);
}

// ─── CLI ────────────────────────────────────────────────────────────────

const FILES_TO_UPDATE = [
  // [relative-path, replaceAll?]
  // replaceAll matters for package-lock.json because it carries "version"
  // twice (top-level + packages[""]).
  ['package.json', false],
  ['package-lock.json', true],
  ['manifest.json', false],
  ['src/chrome/manifest.json', false],
  ['src/firefox/manifest.json', false],
];

function runCli() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, '..');

  const arg = (process.argv[2] || 'patch').trim();

  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const oldVersion = pkg.version;
  let newVersion;
  try {
    newVersion = bumpSemver(oldVersion, arg);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  if (newVersion === oldVersion) {
    console.error(`✗ New version (${newVersion}) equals current version. Nothing to do.`);
    process.exit(1);
  }

  console.log(`Bumping version ${oldVersion} → ${newVersion}`);

  for (const [rel, replaceAll] of FILES_TO_UPDATE) {
    const abs = path.join(root, rel);
    const before = readFileSync(abs, 'utf8');
    const after = rewriteVersionInJsonText(before, oldVersion, newVersion, { replaceAll });
    if (before === after) {
      console.error(`✗ ${rel}: no "version": "${oldVersion}" found — file may be out of sync.`);
      process.exit(1);
    }
    writeFileSync(abs, after);
    console.log(`  ✓ ${rel}`);
  }

  console.log('');
  console.log('Next steps:');
  console.log(`  git add ${FILES_TO_UPDATE.map(([f]) => f).join(' ')}`);
  console.log(`  git commit -m "chore: bump version ${oldVersion} → ${newVersion}"`);
  console.log('  npm run build:zip       # rebuild dist/webbrain-{chrome,firefox}-' + newVersion + '.zip');
  console.log('  git rm dist/webbrain-{chrome,firefox}-' + oldVersion + '.zip');
  console.log('  git add dist/webbrain-{chrome,firefox}-' + newVersion + '.zip');
  console.log('  git commit -m "dist: rebuild submission zips for v' + newVersion + '"');
}

// Guarded entry point — only run the CLI when this file is invoked
// directly (e.g. `node scripts/bump-version.mjs`), NOT when it's imported
// by the test runner.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
