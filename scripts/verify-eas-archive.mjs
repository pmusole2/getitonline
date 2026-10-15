#!/usr/bin/env node
// Checks the set of files an EAS build would upload, without any network access.
//
// Usage:
//   node scripts/verify-eas-archive.mjs <directory | archive.tar | archive.tar.gz | archive.tgz>
//     [--list <file>] [--json] [--strict-no-railway]
//     [--max-files <n>] [--max-total-bytes <n>] [--max-file-bytes <n>]
//
// A directory is walked, or, with --list, only the paths in the list file (relative to the directory) are checked.
// An archive (for example one from `eas build --local` or `tar`) is listed with `tar`, checked for link and budget
// problems, then extracted to a private temporary directory. Content checks run while the extracted files still
// exist, and the directory is removed afterwards, including when a check throws.
//
// Text files are scanned in bounded windows up to --max-file-bytes. Anything that cannot be fully inspected (an
// over-cap text file, an unreadable file, a discovered file that is gone before it is read, a missing --list entry, a
// --list entry that names a directory, a FIFO, socket, device or directory, an exceeded budget, an archive link entry,
// an empty upload set, or a file that changed during inspection) is a FAIL with rule 'incomplete-inspection', never a
// pass. A symbolic link is followed to its real path: a target that is a regular file inside the target root is scanned
// under the link's path, and any other target is a 'path-escape' FAIL. Each text file is opened with O_NOFOLLOW and
// O_NONBLOCK, and its opened descriptor must be the same regular file that lstat saw (same device and inode) before any
// byte is read; a replacement by a link, FIFO or different file is 'changed-during-inspection'. Platforms without
// O_NOFOLLOW fail closed ('no-nofollow'). Binary files (NUL bytes in the first 8 KiB) are recorded as 'skipped-binary'.
//
// Exit codes: 0 = no FAIL findings, 1 = at least one FAIL finding, 2 = usage or read error.
// Secret matches are reported by file, line and rule name only. The matched text is never printed. Every path,
// target and diagnostic passes through redact() before it reaches a finding or any output.

import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REDACTED = '[redacted]';
const DEFAULT_LIMITS = { maxFiles: 20000, maxTotalBytes: 1024 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024 };
const LIMIT_FLAGS = {
  '--max-files': 'maxFiles',
  '--max-total-bytes': 'maxTotalBytes',
  '--max-file-bytes': 'maxFileBytes',
};
const READ_CHUNK_BYTES = 64 * 1024;
const BINARY_PROBE_BYTES = 8000;
const MAX_UNTERMINATED_LINE_CHARS = 64 * 1024;
const LINE_OVERLAP_CHARS = 1024;
const MAX_LISTING_BYTES = 256 * 1024 * 1024;
const GIT_DIRECTORY = '.git';
const DEPENDENCY_DIRECTORY = 'node_modules';
const UPLOAD_SET_PATH = '(upload set)';
const ARCHIVE_PATH = '(archive listing)';
const PRIVATE_KEY_EXTENSIONS = new Set(['.pem', '.p8', '.p12', '.key', '.keystore', '.jks', '.mobileprovision']);
const APP_BINARY_EXTENSIONS = new Set(['.apk', '.aab', '.ipa']);
const STORE_CREDENTIAL_NAMES = new Set(['credentials.json', 'google-services.json', 'googleservice-info.plist']);
const EVIDENCE_NAME_PATTERN = /(reconciliation|privileged[-_ ]?account|release[-_]evidence)/i;
const EVIDENCE_EXTENSIONS = new Set(['.csv', '.tsv', '.json', '.txt', '.md', '.xlsx', '.xls', '.pdf']);
const ANY_LEVEL_PRIVATE_DIRECTORIES = new Set(['.superpowers']);
const TOP_LEVEL_PRIVATE_DIRECTORIES = new Set(['artifacts']);
// Files that already fail by name are not read, so no private content is loaded just to check it.
const NAME_FAILURES_SKIPPING_CONTENT = new Set([
  'env-file',
  'private-key-file',
  'store-credential-file',
  'node-modules-directory',
  'git-directory',
]);
const CODE_OR_CONFIG_PATTERN = /\.(?:[cm]?[jt]sx?|json)$/;
const RAILWAY_RULE_IDS = new Set([
  'railway-host',
  'railway-reference-config',
  'localhost-api-fallback',
  'api-url-required',
]);

const MESSAGES = {
  'env-file': 'environment file; only .env.example may be uploaded',
  'private-key-file': 'private key, certificate, keystore or provisioning profile',
  'store-credential-file': 'store or service-account credential file',
  'app-binary-file': 'downloaded app binary; never part of the source upload',
  'private-evidence-file': 'release or reconciliation evidence export',
  'private-evidence-location': 'file under a private evidence location (.gitignore: .superpowers/, /artifacts/)',
  'node-modules-directory': 'dependency directory; installed packages must not be uploaded',
  'git-directory': 'git metadata must not be uploaded',
  'path-escape': 'path is absolute, contains .., or resolves outside the target; it was not read',
  'skipped-binary': 'binary file (NUL bytes in the first 8 KiB); recorded, not text-scanned',
  'openai-api-key': 'value matches an OpenAI API key pattern',
  'clerk-secret-key': 'value matches a Clerk secret key pattern',
  'private-key-block': 'PEM private key block',
  'bearer-token': 'bearer token literal',
  'secret-assignment': 'secret-named setting assigned a literal value',
  'high-entropy-secret': 'secret-named string literal with high entropy',
  'railway-host': 'references a railway.app host (Railway runtime dependency)',
  'railway-reference-config': 'mentions Railway in build or app configuration',
  'localhost-api-fallback': 'localhost API fallback in source or config',
  'api-url-required':
    'EXPO_PUBLIC_API_URL is required by the build config (Milestone 3: remove once payments and Pinkie run on Convex)',
};

// Reasons for 'incomplete-inspection'. Each one is a FAIL: the upload set was not fully checked.
const REASONS = {
  'listed-file-missing': 'file named in --list does not exist; the upload set cannot be fully inspected',
  missing: 'file disappeared during inspection',
  unreadable: 'file could not be read',
  'file-over-cap': 'text file is larger than --max-file-bytes, so its content was not fully scanned',
  'budget-files': 'more files than --max-files',
  'budget-bytes': 'upload set is larger than --max-total-bytes',
  'link-entry': 'archive contains a link entry; links are not extracted, so the archive cannot be fully inspected',
  'special-entry':
    'entry is not a regular file (directory, FIFO, socket, device or similar); it cannot be fully inspected',
  'listed-entry-not-file':
    '--list names a directory, not a file; list each file path, or the directory is not inspected',
  'no-files-inspected': 'no files were found to inspect; an empty upload set cannot be verified',
  'listing-mismatch': 'archive listing could not be matched to its entries',
  'unknown-size': 'archive entry size is not available',
  'changed-during-inspection':
    'file changed while it was being inspected (replaced by a link, special file or different file); it was not fully checked',
  'no-nofollow':
    'this platform cannot open files without following symbolic links, so no file content can be checked safely',
};

class UsageError extends Error {}

// ---- Redaction: the one function every path, target and diagnostic passes through before output -----------------

const OPENAI_KEY_PATTERN = /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/;
const CLERK_KEY_PATTERN = /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const BEARER_TOKEN_PATTERN = /\bBearer [A-Za-z0-9._~+/-]{20,}=*/;
const SECRET_ASSIGNMENT_PATTERN = /(?<![A-Za-z0-9_])["'`]?([A-Za-z][A-Za-z0-9_]*)["'`]?\s*[:=]\s*(["'`]?)([^\s"'`;,]+)/;
const HIGH_ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9+_=-]{24,}/g;

const SECRET_VALUE_PATTERNS = [
  OPENAI_KEY_PATTERN,
  CLERK_KEY_PATTERN,
  PRIVATE_KEY_BLOCK_PATTERN,
  BEARER_TOKEN_PATTERN,
  SECRET_ASSIGNMENT_PATTERN,
].map((pattern) => new RegExp(pattern.source, 'g'));

function shannonBitsPerCharacter(value) {
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

function isHighEntropyToken(token) {
  return token.length >= 24 && /[A-Za-z]/.test(token) && /[0-9]/.test(token) && shannonBitsPerCharacter(token) >= 4;
}

function redact(text) {
  let redacted = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted.replace(HIGH_ENTROPY_TOKEN_PATTERN, (token) => (isHighEntropyToken(token) ? REDACTED : token));
}

// ---- Findings -------------------------------------------------------------------------------------------------------

function makeFinding(severity, rule, path, line, reason) {
  const finding = {
    severity,
    rule: reason ? 'incomplete-inspection' : rule,
    path: redact(path),
    message: reason ? REASONS[reason] : MESSAGES[rule],
  };
  if (reason) {
    finding.reason = reason;
  }
  if (line !== undefined) {
    finding.line = line;
  }
  return finding;
}

function failure(rule, path, line) {
  return makeFinding('fail', rule, path, line);
}

function incomplete(reason, path) {
  return makeFinding('fail', 'incomplete-inspection', path, undefined, reason);
}

// ---- Name checks ----------------------------------------------------------------------------------------------------

const SECRET_NAMED_KEY_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|SIGNING)|^LENCO_[A-Z0-9_]*(?:KEY|SECRET|TOKEN)$/i;
const PLACEHOLDER_PATTERN = /[$<{}]|process\.|example|placeholder|changeme|your[-_]|x{3,}|\.\.\./i;

// Directory is a dependency tree when it is the root node_modules, or contains .bin or an installed package.
function dependencyTreesFrom(relatives) {
  const trees = new Set([DEPENDENCY_DIRECTORY]);
  for (const relative of relatives) {
    const segments = relative.split('/');
    segments.forEach((segment, index) => {
      if (index === 0 || segment !== DEPENDENCY_DIRECTORY) {
        return;
      }
      const child = segments[index + 1];
      const manifestIndex = child?.startsWith('@') ? index + 3 : index + 2;
      const isTree =
        child === '.bin' || (segments[manifestIndex] === 'package.json' && segments.length === manifestIndex + 1);
      if (isTree) {
        trees.add(segments.slice(0, index + 1).join('/'));
      }
    });
  }
  return trees;
}

async function isDependencyTree(absoluteDirectory, relativeDirectory) {
  if (relativeDirectory === DEPENDENCY_DIRECTORY) {
    return true;
  }
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name.startsWith('@')) {
      return true;
    }
    if (entry.isDirectory() && (await exists(join(absoluteDirectory, entry.name, 'package.json')))) {
      return true;
    }
  }
  return false;
}

async function exists(absolutePath) {
  try {
    await lstat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function checkName(relativePath, dependencyTrees) {
  const segments = relativePath.split('/');
  const name = segments[segments.length - 1];
  const lower = name.toLowerCase();
  const extension = extname(lower);

  const gitIndex = segments.indexOf(GIT_DIRECTORY);
  if (gitIndex !== -1) {
    return [failure('git-directory', segments.slice(0, gitIndex + 1).join('/'))];
  }
  const treeIndex = segments.findIndex(
    (segment, index) => segment === DEPENDENCY_DIRECTORY && dependencyTrees.has(segments.slice(0, index + 1).join('/')),
  );
  if (treeIndex !== -1) {
    return [failure('node-modules-directory', segments.slice(0, treeIndex + 1).join('/'))];
  }

  const findings = [];
  if (name === '.env' || (lower.startsWith('.env.') && lower !== '.env.example')) {
    findings.push(failure('env-file', relativePath));
  }
  if (PRIVATE_KEY_EXTENSIONS.has(extension)) {
    findings.push(failure('private-key-file', relativePath));
  }
  if (STORE_CREDENTIAL_NAMES.has(lower) || /service[-_]account[^/]*\.json$/.test(lower)) {
    findings.push(failure('store-credential-file', relativePath));
  }
  if (APP_BINARY_EXTENSIONS.has(extension)) {
    findings.push(failure('app-binary-file', relativePath));
  }
  if (EVIDENCE_NAME_PATTERN.test(name) && EVIDENCE_EXTENSIONS.has(extension)) {
    findings.push(failure('private-evidence-file', relativePath));
  }
  const inPrivateDirectory =
    segments.slice(0, -1).some((segment) => ANY_LEVEL_PRIVATE_DIRECTORIES.has(segment)) ||
    (segments.length > 1 && TOP_LEVEL_PRIVATE_DIRECTORIES.has(segments[0]));
  if (inPrivateDirectory) {
    findings.push(failure('private-evidence-location', relativePath));
  }
  return findings;
}

// ---- Content rules --------------------------------------------------------------------------------------------------

const QUOTED_LITERAL_PATTERN = /["'`]([A-Za-z0-9+/_=-]{32,})["'`]/;

// A named secret needs at least 16 characters, both letters and digits, and no placeholder wording.
function isStrongSecretValue(value) {
  return value.length >= 16 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && !PLACEHOLDER_PATTERN.test(value);
}

// Matches unquoted, single-quoted, double-quoted and backtick-quoted keys (.env, YAML, JSON, TypeScript objects).
function hasSecretAssignment(line, relativePath) {
  for (const match of line.matchAll(new RegExp(SECRET_ASSIGNMENT_PATTERN.source, 'g'))) {
    const [, name, quote, value] = match;
    // Calls in JavaScript/TypeScript are expressions. The same bytes in configuration or a quoted value remain literals.
    const isCodeCall =
      !quote && /\.[cm]?[jt]sx?$/.test(relativePath) && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/.test(value);
    if (isCodeCall) {
      continue;
    }
    if (SECRET_NAMED_KEY_PATTERN.test(name) && isStrongSecretValue(value)) {
      return true;
    }
  }
  return false;
}

function hasHighEntropyLiteral(line) {
  if (!/(secret|token|api[_-]?key|private[_-]?key|password)/i.test(line)) {
    return false;
  }
  const match = QUOTED_LITERAL_PATTERN.exec(line);
  return match !== null && shannonBitsPerCharacter(match[1] ?? '') >= 4;
}

// Each rule either matches a regular expression or runs a test. The matched text is never part of a finding.
// Rules marked requiresFileWording fire only when the same file also contains "required" or "missing" wording.
const CONTENT_RULES = [
  { id: 'openai-api-key', pattern: OPENAI_KEY_PATTERN },
  { id: 'clerk-secret-key', pattern: CLERK_KEY_PATTERN },
  { id: 'private-key-block', pattern: PRIVATE_KEY_BLOCK_PATTERN },
  { id: 'bearer-token', pattern: BEARER_TOKEN_PATTERN },
  { id: 'secret-assignment', test: hasSecretAssignment },
  { id: 'high-entropy-secret', test: hasHighEntropyLiteral },
  { id: 'railway-host', pattern: /\brailway\.app\b/i },
  {
    id: 'railway-reference-config',
    pattern: /railway/i,
    appliesTo: (relativePath) => ['eas.json', 'app.config.ts'].includes(basename(relativePath)),
  },
  {
    id: 'localhost-api-fallback',
    pattern: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2)(?::\d+)?/,
    appliesTo: (relativePath) => CODE_OR_CONFIG_PATTERN.test(relativePath),
  },
  {
    id: 'api-url-required',
    test: (line) => line.includes('EXPO_PUBLIC_API_URL'),
    appliesTo: (relativePath) => ['app.config.ts', 'runtime.ts'].includes(basename(relativePath)),
    requiresFileWording: true,
  },
];

// Line-based scanner fed with decoded text windows. An unterminated line longer than MAX_UNTERMINATED_LINE_CHARS is scanned in
// place and its last LINE_OVERLAP_CHARS are kept, so a match that crosses a window edge is still found.
function createLineScanner(relativePath) {
  const applicable = CONTENT_RULES.filter((rule) => !rule.appliesTo || rule.appliesTo(relativePath));
  const hits = [];
  const pendingWording = new Map();
  let lineNumber = 1;
  let carry = '';
  let fileHasRequiredWording = false;

  function scanLine(line) {
    if (/required|missing/i.test(line)) {
      fileHasRequiredWording = true;
    }
    for (const rule of applicable) {
      if (rule.requiresFileWording) {
        if (!pendingWording.has(rule.id) && rule.test(line)) {
          pendingWording.set(rule.id, lineNumber);
        }
        continue;
      }
      const matched = rule.pattern ? rule.pattern.test(line) : rule.test(line, relativePath);
      if (matched) {
        hits.push({ rule: rule.id, line: lineNumber });
      }
    }
  }

  return {
    push(text) {
      const parts = (carry + text).split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) {
        scanLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        lineNumber += 1;
      }
      if (carry.length > MAX_UNTERMINATED_LINE_CHARS) {
        scanLine(carry);
        carry = carry.slice(-LINE_OVERLAP_CHARS);
      }
    },
    finish() {
      if (carry.length > 0) {
        scanLine(carry);
      }
      for (const [rule, line] of pendingWording) {
        if (fileHasRequiredWording) {
          hits.push({ rule, line });
        }
      }
      return hits;
    },
  };
}

function toFinding(rule, relativePath, line, strictNoRailway) {
  if (RAILWAY_RULE_IDS.has(rule)) {
    const severity = strictNoRailway ? 'fail' : 'warning';
    return makeFinding(severity, rule, relativePath, line);
  }
  return failure(rule, relativePath, line);
}

// ---- File inspection ------------------------------------------------------------------------------------------------

async function scanTextStream(handle, firstChunk, relativePath, maxFileBytes) {
  const scanner = createLineScanner(relativePath);
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let chunk = firstChunk;
  let position = 0;
  while (chunk.length > 0) {
    position += chunk.length;
    if (position > maxFileBytes) {
      return { incomplete: 'file-over-cap' };
    }
    scanner.push(decoder.write(chunk));
    const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, position);
    chunk = buffer.subarray(0, bytesRead);
  }
  scanner.push(decoder.end());
  return { hits: scanner.finish() };
}

// Read-only open that does not follow a symbolic link at the final path component (O_NOFOLLOW) and does not block on a
// FIFO (O_NONBLOCK). Platforms that do not define both flags get undefined, and the caller fails closed.
function noFollowOpenFlags() {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;
  return typeof O_NOFOLLOW === 'number' && typeof O_NONBLOCK === 'number'
    ? O_RDONLY | O_NOFOLLOW | O_NONBLOCK
    : undefined;
}

// Filesystem calls that touch the upload set. Tests wrap these to reproduce races at the exact boundary between calls.
export const fsOps = {
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  noFollowFlags: () => noFollowOpenFlags(),
  open: (path, flags) => open(path, flags),
};

async function inspectFile(file, limits, budget) {
  let info;
  try {
    info = await fsOps.lstat(file.abs);
  } catch (error) {
    return error.code === 'ENOENT' ? { skipped: 'missing' } : { incomplete: 'unreadable' };
  }
  // The caller passes the real path, so a symbolic link is never seen here. Anything that is not a regular file is an
  // unsupported entry, and it is reported without being opened.
  if (!info.isFile()) {
    return { incomplete: 'special-entry' };
  }
  if (budget.bytes + info.size > limits.maxTotalBytes) {
    return { incomplete: 'budget-bytes' };
  }
  const flags = fsOps.noFollowFlags();
  if (flags === undefined) {
    return { incomplete: 'no-nofollow' };
  }
  budget.bytes += info.size;

  let handle;
  try {
    handle = await fsOps.open(file.abs, flags);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { skipped: 'missing' };
    }
    // O_NOFOLLOW refuses a symbolic link that replaced the regular file after lstat (ELOOP).
    return { incomplete: error.code === 'ELOOP' ? 'changed-during-inspection' : 'unreadable' };
  }
  try {
    // The identity check runs before any byte is read. The opened descriptor must be the same regular file that lstat
    // saw, so a replacement by a link, a FIFO or a different file is refused without reading it.
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      return { incomplete: 'changed-during-inspection' };
    }
    // O_NOFOLLOW covers only the last path component. A parent directory replaced by a link after resolution sends the
    // open and lstat to a file outside the root with the same identity, so the resolved path must still be the path.
    if ((await fsOps.realpath(file.abs)) !== file.abs) {
      return { incomplete: 'changed-during-inspection' };
    }
    const probe = Buffer.alloc(READ_CHUNK_BYTES);
    const { bytesRead } = await handle.read(probe, 0, READ_CHUNK_BYTES, 0);
    if (probe.subarray(0, Math.min(bytesRead, BINARY_PROBE_BYTES)).includes(0)) {
      return { skipped: 'binary' };
    }
    if (info.size > limits.maxFileBytes) {
      return { incomplete: 'file-over-cap' };
    }
    return await scanTextStream(handle, probe.subarray(0, bytesRead), file.rel, limits.maxFileBytes);
  } catch {
    return { incomplete: 'unreadable' };
  } finally {
    await handle.close();
  }
}

// Resolves a path under root (a real path). 'inside' carries the real path, which is the link target for a symbolic link.
async function locate(root, relativePath) {
  let real;
  try {
    real = await fsOps.realpath(join(root, relativePath));
  } catch (error) {
    return { status: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
  return real === root || real.startsWith(`${root}${sep}`) ? { status: 'inside', path: real } : { status: 'escape' };
}

async function analyze(files, initialFindings, context) {
  const findings = [...initialFindings];
  const skipped = { missing: 0, binary: 0, incomplete: 0 };
  const budget = { bytes: 0, bytesReported: false };
  let filesFound = 0;
  let filesReported = false;
  let textFilesScanned = 0;

  for (const file of files) {
    filesFound += 1;
    const nameFindings = checkName(file.rel, context.dependencyTrees);
    findings.push(...nameFindings);
    if (file.abs === null || nameFindings.some((finding) => NAME_FAILURES_SKIPPING_CONTENT.has(finding.rule))) {
      continue;
    }
    if (filesFound > context.limits.maxFiles) {
      skipped.incomplete += 1;
      if (!filesReported) {
        findings.push(incomplete('budget-files', UPLOAD_SET_PATH));
        filesReported = true;
      }
      continue;
    }
    // A symbolic link is followed to its real path. The real path must stay inside the root, or the file is not read.
    const location = await locate(file.root, file.rel);
    if (location.status === 'escape') {
      findings.push(failure('path-escape', file.rel));
      continue;
    }
    if (location.status === 'missing') {
      skipped.missing += 1;
      findings.push(incomplete(file.fromList ? 'listed-file-missing' : 'missing', file.rel));
      continue;
    }
    if (location.status === 'unreadable') {
      skipped.incomplete += 1;
      findings.push(incomplete('unreadable', file.rel));
      continue;
    }

    const result = await inspectFile({ ...file, abs: location.path }, context.limits, budget);
    if (result.skipped) {
      skipped[result.skipped] += 1;
      if (result.skipped === 'missing') {
        // A discovered file that is gone before it is read was not checked, so it fails in every mode.
        findings.push(incomplete(file.fromList ? 'listed-file-missing' : 'missing', file.rel));
      }
      if (result.skipped === 'binary') {
        findings.push(makeFinding('info', 'skipped-binary', file.rel));
      }
      continue;
    }
    if (result.incomplete === 'budget-bytes') {
      skipped.incomplete += 1;
      if (!budget.bytesReported) {
        findings.push(incomplete('budget-bytes', UPLOAD_SET_PATH));
        budget.bytesReported = true;
      }
      continue;
    }
    if (result.incomplete) {
      skipped.incomplete += 1;
      findings.push(incomplete(result.incomplete, file.rel));
      continue;
    }
    textFilesScanned += 1;
    for (const hit of result.hits) {
      findings.push(toFinding(hit.rule, file.rel, hit.line, context.strictNoRailway));
    }
  }

  if (filesFound === 0) {
    findings.push(incomplete('no-files-inspected', UPLOAD_SET_PATH));
  }
  return { findings: dedupeAndSort(findings), skipped, textFilesScanned, filesInspected: filesFound };
}

function dedupeAndSort(findings) {
  const seen = new Map();
  for (const finding of findings) {
    seen.set(`${finding.severity}\u0000${finding.rule}\u0000${finding.path}\u0000${finding.line ?? ''}`, finding);
  }
  const severityOrder = { fail: 0, warning: 1, info: 2 };
  return [...seen.values()].sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.rule.localeCompare(b.rule),
  );
}

// ---- Upload-set sources: directory walk, --list, archive ------------------------------------------------------------

function classifyEntry(rawEntry) {
  const entry = rawEntry.startsWith('./') ? rawEntry.slice(2) : rawEntry;
  if (entry === '' || entry === '.' || entry.endsWith('/')) {
    return { kind: 'directory' };
  }
  const segments = entry.split('/');
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry) || segments.includes('..')) {
    return { kind: 'unsafe' };
  }
  return { kind: 'file', rel: segments.filter((segment) => segment !== '.' && segment !== '').join('/') };
}

async function walkDirectory(root) {
  const files = [];
  // root is a real path, so every walked file is checked against it.
  const findings = [];
  async function visit(absoluteDirectory, relativeDirectory) {
    const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const rel = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const abs = join(absoluteDirectory, entry.name);
      if (entry.isDirectory() && entry.name === GIT_DIRECTORY) {
        findings.push(...checkName(rel, new Set()));
      } else if (entry.isDirectory() && entry.name === DEPENDENCY_DIRECTORY && (await isDependencyTree(abs, rel))) {
        findings.push(failure('node-modules-directory', rel));
      } else if (entry.isDirectory()) {
        await visit(abs, rel);
      } else {
        files.push({ rel, abs, root, fromList: false });
      }
    }
  }
  await visit(root, '');
  return { files, findings };
}

async function filesFromList(root, listFile) {
  const lines = (await readFile(listFile, 'utf8')).split(/\r?\n/);
  const files = [];
  const findings = [];
  lines.forEach((raw, index) => {
    const entry = raw.trim();
    if (entry === '' || entry.startsWith('#')) {
      return;
    }
    const classified = classifyEntry(entry);
    if (classified.kind === 'unsafe') {
      findings.push(failure('path-escape', `--list line ${index + 1}`));
    } else if (classified.kind === 'directory') {
      findings.push(incomplete('listed-entry-not-file', `--list line ${index + 1}`));
    } else if (classified.kind === 'file') {
      files.push({ rel: classified.rel, abs: join(root, classified.rel), root, fromList: true });
    }
  });
  return { files, findings };
}

function splitLines(text) {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

// Size is the first number before a date in both bsdtar ("staff  2 Oct 10 18:56") and GNU tar ("user/group 2 2026-10-10 18:56").
function parseTarSize(detailLine) {
  const match = /\s(\d+)\s+(?:[A-Z][a-z]{2}\s+\d{1,2}\s+[\d:]+|\d{4}-\d{2}-\d{2}\s+[\d:]+)\s/.exec(detailLine);
  return match ? Number(match[1]) : null;
}

async function inspectArchive(archivePath, gzipped, context) {
  const compression = gzipped ? 'z' : '';
  const [names, details] = await Promise.all([
    execFileAsync('tar', [`-t${compression}f`, archivePath], { maxBuffer: MAX_LISTING_BYTES }),
    execFileAsync('tar', [`-tv${compression}f`, archivePath], { maxBuffer: MAX_LISTING_BYTES }),
  ]);
  const entries = splitLines(names.stdout);
  const detailLines = splitLines(details.stdout);
  if (entries.length !== detailLines.length) {
    return analyze([], [incomplete('listing-mismatch', ARCHIVE_PATH)], context);
  }

  const findings = [];
  const memberNames = [];
  const members = [];
  let totalBytes = 0;
  let namesOnly = false;
  entries.forEach((raw, index) => {
    const classified = classifyEntry(raw);
    const type = detailLines[index][0];
    if (classified.kind === 'unsafe') {
      findings.push(failure('path-escape', `archive entry ${index + 1}`));
      namesOnly = true;
      return;
    }
    if (classified.kind === 'directory' || type === 'd') {
      return;
    }
    memberNames.push(classified.rel);
    if (type === 'l' || type === 'h') {
      findings.push(incomplete('link-entry', classified.rel));
      namesOnly = true;
      return;
    }
    if (type !== '-') {
      findings.push(incomplete('special-entry', classified.rel));
      namesOnly = true;
      return;
    }
    const size = parseTarSize(detailLines[index]);
    if (size === null) {
      findings.push(incomplete('unknown-size', classified.rel));
      namesOnly = true;
      return;
    }
    totalBytes += size;
    members.push(classified.rel);
  });

  if (!namesOnly && members.length > context.limits.maxFiles) {
    findings.push(incomplete('budget-files', UPLOAD_SET_PATH));
    namesOnly = true;
  }
  if (!namesOnly && totalBytes > context.limits.maxTotalBytes) {
    findings.push(incomplete('budget-bytes', UPLOAD_SET_PATH));
    namesOnly = true;
  }
  const archiveContext = { ...context, dependencyTrees: dependencyTreesFrom(memberNames) };
  if (namesOnly) {
    // Unsafe, linked or over-budget archives are never extracted; only their member names are checked.
    const files = memberNames.map((rel) => ({ rel, abs: null, root: null, fromList: false }));
    return analyze(files, findings, archiveContext);
  }

  // Extraction happens into a private directory. Analysis runs while it exists, and it is removed afterwards even
  // when a check throws.
  const extractRoot = await mkdtemp(join(tmpdir(), 'verify-eas-archive-'));
  try {
    await execFileAsync(
      'tar',
      [`-x${compression}f`, archivePath, '-C', extractRoot, '--no-same-owner', '--no-same-permissions'],
      { maxBuffer: MAX_LISTING_BYTES },
    );
    const root = await realpath(extractRoot);
    const files = members.map((rel) => ({ rel, abs: join(root, rel), root, fromList: false }));
    return await analyze(files, findings, archiveContext);
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}

// ---- Entry point ----------------------------------------------------------------------------------------------------

async function inspect(target, options) {
  const targetStat = await stat(target);
  const context = { limits: options.limits, strictNoRailway: options.strictNoRailway };

  if (targetStat.isDirectory()) {
    if (options.list) {
      const root = await realpath(target);
      const { files, findings } = await filesFromList(root, options.list);
      const dependencyTrees = dependencyTreesFrom(files.map((file) => file.rel));
      return { mode: 'list', analysis: await analyze(files, findings, { ...context, dependencyTrees }) };
    }
    const { files, findings } = await walkDirectory(await realpath(target));
    return { mode: 'directory', analysis: await analyze(files, findings, { ...context, dependencyTrees: new Set() }) };
  }

  if (targetStat.isFile() && /\.(?:tar|tar\.gz|tgz)$/i.test(target)) {
    if (options.list) {
      throw new UsageError('--list applies to directories, not archives');
    }
    const gzipped = /\.(?:tar\.gz|tgz)$/i.test(target);
    return { mode: 'archive', analysis: await inspectArchive(target, gzipped, context) };
  }

  throw new UsageError('target must be a directory or a .tar, .tar.gz or .tgz archive');
}

function buildReport(target, mode, options, analysis) {
  const counts = {
    fail: analysis.findings.filter((finding) => finding.severity === 'fail').length,
    warning: analysis.findings.filter((finding) => finding.severity === 'warning').length,
    info: analysis.findings.filter((finding) => finding.severity === 'info').length,
  };
  return {
    target: redact(target),
    mode,
    strictNoRailway: options.strictNoRailway,
    limits: options.limits,
    filesInspected: analysis.filesInspected,
    textFilesScanned: analysis.textFilesScanned,
    skippedContent: analysis.skipped,
    findings: analysis.findings,
    counts,
    passed: counts.fail === 0,
  };
}

function parseArguments(argv) {
  const options = {
    target: undefined,
    list: undefined,
    json: false,
    strictNoRailway: false,
    help: false,
    limits: { ...DEFAULT_LIMITS },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--strict-no-railway') {
      options.strictNoRailway = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--list') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError('--list requires a file path');
      }
      options.list = value;
      index += 1;
    } else if (Object.hasOwn(LIMIT_FLAGS, argument)) {
      const value = argv[index + 1];
      if (value === undefined || !/^[1-9]\d*$/.test(value)) {
        throw new UsageError(`${argument} requires a positive whole number`);
      }
      options.limits[LIMIT_FLAGS[argument]] = Number(value);
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new UsageError(`unknown option ${redact(argument)}`);
    } else if (options.target === undefined) {
      options.target = argument;
    } else {
      throw new UsageError('only one target may be given');
    }
  }
  if (!options.help && options.target === undefined) {
    throw new UsageError('a target directory or archive is required');
  }
  return options;
}

const USAGE =
  'Usage: node scripts/verify-eas-archive.mjs <directory|archive.tar|archive.tar.gz|archive.tgz> ' +
  '[--list <file>] [--json] [--strict-no-railway] [--max-files <n>] [--max-total-bytes <n>] [--max-file-bytes <n>]';

function formatHumanReport(report) {
  const lines = [
    'EAS upload archive check',
    `Target: ${report.target} (${report.mode})`,
    `Files in upload set: ${report.filesInspected}`,
    `Text files scanned: ${report.textFilesScanned}`,
    `Binary files recorded, not text-scanned: ${report.skippedContent.binary}`,
    `Railway runtime checks: ${report.strictNoRailway ? 'fail (--strict-no-railway)' : 'warning'}`,
  ];
  const sections = [
    ['FAIL', report.findings.filter((finding) => finding.severity === 'fail')],
    ['WARNING', report.findings.filter((finding) => finding.severity === 'warning')],
  ];
  for (const [title, findings] of sections) {
    if (findings.length === 0) {
      continue;
    }
    lines.push('', `${title} (${findings.length}):`);
    for (const finding of findings) {
      const location = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
      lines.push(`  [${finding.rule}] ${location}`, `      ${finding.message}`);
    }
  }
  lines.push(
    '',
    report.passed
      ? `Result: PASS (${report.counts.warning} warning${report.counts.warning === 1 ? '' : 's'})`
      : `Result: FAIL (${report.counts.fail} failure${report.counts.fail === 1 ? '' : 's'}, ` +
          `${report.counts.warning} warning${report.counts.warning === 1 ? '' : 's'})`,
  );
  return `${lines.join('\n')}\n`;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let report;
  try {
    const { mode, analysis } = await inspect(options.target, options);
    report = buildReport(options.target, mode, options, analysis);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${USAGE}\n`);
    } else {
      process.stderr.write(`Could not inspect the target (${error.code ?? 'error'}).\n`);
    }
    process.exitCode = 2;
    return;
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatHumanReport(report));
  process.exitCode = report.passed ? 0 : 1;
}

export { buildReport, inspect };

// The CLI runs only when this file is the entry point, so tests can import the functions above without running it.
// Both sides are canonicalized, because --preserve-symlinks-main keeps the symlink path in import.meta.url. If either
// side cannot be resolved, the CLI runs: a verifier must never exit 0 without inspecting the target.
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) {
    return true;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}
if (isEntryPoint()) {
  await main();
}
