// Tests for scripts/verify-eas-archive.mjs. Run with: npx tsx --test scripts/verify-eas-archive.test.mjs
// Each test builds its own fixture under os.tmpdir() and removes it afterwards. The CLI is run as a child process so
// the exit codes and printed output are what is asserted.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, 'verify-eas-archive.mjs');
const fixtureRoots = [];

after(async () => {
  await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true, force: true })));
});

// Secrets are assembled from parts so this test file does not contain a secret-looking literal itself.
const FIXTURE_SECRET = ['sk', 'testfixtureValue', '0123456789abcdefABCD'].join('-');
const FIXTURE_SECRET_PARTS = ['testfixtureValue', '0123456789abcdefABCD'];
const SIGNING_VALUE = ['whsec', 'Test0123456789abcdEF'].join('_');
const RAILWAY_URL = ['https://gettitonline', 'up', 'railway', 'app'].join('.');

const CLEAN_TREE = {
  'app.config.ts': 'export default { name: "Getitonline", version: "1.0.0" };\n',
  'package.json': '{ "name": "mobile" }\n',
  'src/App.tsx': 'export const App = () => null;\n',
  '.env.example': 'EXPO_PUBLIC_APP_ENV=production\nEXPO_PUBLIC_CONVEX_URL=<your-convex-url>\n',
};

async function makeFixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'eas-archive-test-'));
  fixtureRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  return root;
}

// Builds a .tar.gz of a fixture tree, the same way the directory is later walked, and returns the archive path.
async function makeArchive(files, { gzip = true } = {}) {
  const root = await makeFixture(files);
  const archiveRoot = await makeFixture({});
  const archive = join(archiveRoot, gzip ? 'upload.tar.gz' : 'upload.tar');
  const flags = gzip ? '-czf' : '-cf';
  assert.equal(spawnSync('tar', [flags, archive, '-C', root, '.']).status, 0, 'the fixture archive is created');
  return archive;
}

// A timeout turns a verifier that blocks (for example by opening a FIFO) into a failed run, instead of a hung test.
function runCli(args, { timeout = 0 } = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [scriptPath, ...args], { timeout }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function runJson(args, options) {
  const result = await runCli([...args, '--json'], options);
  return { ...result, report: JSON.parse(result.stdout) };
}

function findingsWith(report, rule) {
  return report.findings.filter((finding) => finding.rule === rule);
}

// Asserts that neither the human nor the JSON output of a run contains the secret or any part of it.
async function assertNoSecretInOutput(args, secret, parts) {
  const human = await runCli(args);
  const json = await runCli([...args, '--json']);
  for (const output of [human.stdout, human.stderr, json.stdout, json.stderr]) {
    assert.ok(!output.includes(secret), 'the full secret is not printed');
    for (const part of parts) {
      assert.ok(!output.includes(part), 'no part of the secret is printed');
    }
  }
  return { human, json };
}

function findingKeys(report) {
  return report.findings.map((finding) => `${finding.severity} ${finding.rule} ${finding.path} ${finding.line ?? ''}`);
}

const tarAvailable = spawnSync('tar', ['--version']).status === 0;
const tarSkip = tarAvailable ? false : 'tar is not available on this machine';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('a clean tree passes with exit code 0 and no failures', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const { code, report } = await runJson([root]);
  assert.equal(code, 0);
  assert.equal(report.passed, true);
  assert.equal(report.counts.fail, 0);
});

test('a .env file in the upload set fails with an env-file finding', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, '.env': 'EXPO_PUBLIC_APP_ENV=production\n' });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(report.passed, false);
  const [finding] = findingsWith(report, 'env-file');
  assert.ok(finding, 'an env-file finding is reported');
  assert.equal(finding.severity, 'fail');
  assert.equal(finding.path, '.env');
});

test('.env.example is allowed and produces no env-file finding', async () => {
  const root = await makeFixture({ '.env.example': 'EXPO_PUBLIC_APP_ENV=production\n', 'src/App.tsx': '' });
  const { code, report } = await runJson([root]);
  assert.equal(code, 0);
  assert.deepEqual(findingsWith(report, 'env-file'), []);
});

test('a .env.local file is treated as an env file', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, '.env.production.local': 'EXPO_PUBLIC_APP_ENV=production\n' });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'env-file')[0]?.path, '.env.production.local');
});

for (const privateFile of [
  'ios/AuthKey.p8',
  'android/upload.keystore',
  'ios/app.mobileprovision',
  'certs/server.pem',
]) {
  test(`private key or signing file ${privateFile} fails`, async () => {
    const root = await makeFixture({ ...CLEAN_TREE, [privateFile]: 'not-a-real-key-body\n' });
    const { code, report } = await runJson([root]);
    assert.equal(code, 1);
    assert.equal(findingsWith(report, 'private-key-file')[0]?.path, privateFile);
  });
}

test('a service account JSON file fails', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, 'android/service-account-play.json': '{}\n' });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'store-credential-file')[0]?.path, 'android/service-account-play.json');
});

test('a secret-looking value fails with file and line, and its text is never printed', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'src/config.ts': `export const fixtureKey = "${FIXTURE_SECRET}";\n`,
  });
  const result = await runCli([root]);
  assert.equal(result.code, 1);
  const report = JSON.parse((await runCli([root, '--json'])).stdout);
  const [finding] = findingsWith(report, 'openai-api-key');
  assert.ok(finding, 'the openai-api-key rule matches');
  assert.equal(finding.path, 'src/config.ts');
  assert.equal(finding.line, 1);
  assert.ok(!result.stdout.includes(FIXTURE_SECRET), 'human output does not echo the matched value');
  assert.ok(!result.stdout.includes('testfixtureValue'), 'human output does not echo any part of the value');
  assert.ok(!result.stderr.includes(FIXTURE_SECRET), 'stderr does not echo the matched value');
});

test('a private key PEM header in a text file fails with the rule name only', async () => {
  const header = `-----BEGIN ${'RSA PRIVATE'} KEY-----`;
  const root = await makeFixture({ ...CLEAN_TREE, 'src/signing.ts': `const pem = "${header}";\n` });
  const result = await runCli([root]);
  assert.equal(result.code, 1);
  assert.ok(result.stdout.includes('private-key-block'));
  assert.ok(!result.stdout.includes(header), 'the PEM header is not echoed');
});

test('a node_modules directory fails and is reported once without walking it', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'node_modules/left-pad/index.js': 'module.exports = 1;\n',
    'node_modules/other/index.js': 'module.exports = 2;\n',
  });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  const findings = findingsWith(report, 'node-modules-directory');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, 'node_modules');
});

test('a root node_modules directory fails even without a package.json', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, 'node_modules/readme.txt': 'notes\n' });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'node-modules-directory')[0]?.path, 'node_modules');
});

test('a nested dependency tree (node_modules with package.json) fails', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'packages/tool/node_modules/left-pad/package.json': '{ "name": "left-pad" }\n',
  });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'node-modules-directory')[0]?.path, 'packages/tool/node_modules');
});

test('a nested node_modules folder that is not a dependency tree is allowed', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, 'assets/node_modules/diagram.svg': '<svg></svg>\n' });
  const { code, report } = await runJson([root]);
  assert.equal(code, 0);
  assert.deepEqual(findingsWith(report, 'node-modules-directory'), []);
  assert.equal(report.filesInspected, 5);
});

test('a .git directory fails', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, '.git/HEAD': 'ref: refs/heads/main\n' });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'git-directory')[0]?.path, '.git');
});

test('private evidence locations from .gitignore fail', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    '.superpowers/notes.md': '# notes\n',
    'artifacts/export.csv': 'a,b\n',
  });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  const paths = findingsWith(report, 'private-evidence-location').map((finding) => finding.path);
  assert.ok(paths.includes('.superpowers/notes.md'));
  assert.ok(paths.includes('artifacts/export.csv'));
});

test('a Railway host is a warning by default and passes with exit code 0', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'src/config.ts': `export const apiUrl = "${RAILWAY_URL}";\n`,
  });
  const { code, report } = await runJson([root]);
  assert.equal(code, 0);
  assert.equal(report.passed, true);
  const [finding] = findingsWith(report, 'railway-host');
  assert.ok(finding, 'the railway-host rule matches');
  assert.equal(finding.severity, 'warning');
});

test('the same Railway host fails under --strict-no-railway', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'src/config.ts': `export const apiUrl = "${RAILWAY_URL}";\n`,
  });
  const { code, report } = await runJson([root, '--strict-no-railway']);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'railway-host')[0]?.severity, 'fail');
});

test('a required EXPO_PUBLIC_API_URL is a Milestone 3 warning, and a failure under strict mode', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'app.config.ts': [
      'const requiredVars = ["EXPO_PUBLIC_APP_ENV", "EXPO_PUBLIC_API_URL"];',
      'const missing = requiredVars.filter((name) => !process.env[name]);',
      '',
    ].join('\n'),
  });
  const warned = await runJson([root]);
  assert.equal(warned.code, 0);
  const [warning] = findingsWith(warned.report, 'api-url-required');
  assert.ok(warning, 'the api-url-required rule matches');
  assert.equal(warning.severity, 'warning');
  assert.match(warning.message, /Milestone 3/);

  const strict = await runJson([root, '--strict-no-railway']);
  assert.equal(strict.code, 1);
  assert.equal(findingsWith(strict.report, 'api-url-required')[0]?.severity, 'fail');
});

test('a localhost API fallback is a warning, and a failure under strict mode', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'src/config.ts': 'export const developmentApiUrl = "http://localhost:3001";\n',
  });
  const warned = await runJson([root]);
  assert.equal(warned.code, 0);
  assert.equal(findingsWith(warned.report, 'localhost-api-fallback')[0]?.severity, 'warning');

  const strict = await runJson([root, '--strict-no-railway']);
  assert.equal(strict.code, 1);
});

test('--list checks only the listed upload set, so an unlisted .env does not fail', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, '.env': 'EXPO_PUBLIC_APP_ENV=production\n' });
  const listRoot = await makeFixture({
    'upload-list.txt': ['app.config.ts', 'package.json', 'src/App.tsx', '.env.example', ''].join('\n'),
  });
  const { code, report } = await runJson([root, '--list', join(listRoot, 'upload-list.txt')]);
  assert.equal(code, 0);
  assert.equal(report.mode, 'list');
  assert.equal(report.filesInspected, 4);
});

test('a .tar.gz archive of a clean tree passes', { skip: tarSkip }, async () => {
  const archive = await makeArchive(CLEAN_TREE);
  const { code, report } = await runJson([archive]);
  assert.equal(code, 0);
  assert.equal(report.mode, 'archive');
  assert.equal(report.passed, true);
});

test('a .tar.gz archive containing a .env fails', { skip: tarSkip }, async () => {
  const archive = await makeArchive({ ...CLEAN_TREE, '.env': 'EXPO_PUBLIC_APP_ENV=production\n' });
  const { code, report } = await runJson([archive]);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'env-file')[0]?.path, '.env');
});

test('missing arguments and unknown flags exit with code 2', async () => {
  assert.equal((await runCli([])).code, 2);
  const root = await makeFixture(CLEAN_TREE);
  assert.equal((await runCli([root, '--not-a-flag'])).code, 2);
});

// ---- Finding 1: archive content is scanned while the extracted files still exist -------------------------------

test(
  'a tar containing an OpenAI-pattern secret fails, with the same findings as the directory',
  { skip: tarSkip },
  async () => {
    const tree = { ...CLEAN_TREE, 'src/config.ts': `export const fixtureKey = "${FIXTURE_SECRET}";\n` };
    const root = await makeFixture(tree);
    const archive = await makeArchive(tree);
    const fromDirectory = await runJson([root, '--strict-no-railway']);
    const fromArchive = await runJson([archive, '--strict-no-railway']);
    assert.equal(fromArchive.code, 1, 'the archive fails');
    assert.deepEqual(
      findingsWith(fromArchive.report, 'openai-api-key').map((f) => f.path),
      ['src/config.ts'],
    );
    assert.deepEqual(findingKeys(fromArchive.report), findingKeys(fromDirectory.report));
    assert.equal(fromArchive.report.textFilesScanned, fromDirectory.report.textFilesScanned);
    assert.equal(fromArchive.report.textFilesScanned > 0, true, 'archive members are content-scanned');
  },
);

test(
  'a tar containing a Railway URL fails under --strict-no-railway, the same as the directory',
  { skip: tarSkip },
  async () => {
    const tree = { ...CLEAN_TREE, 'src/config.ts': `export const apiUrl = "${RAILWAY_URL}";\n` };
    const root = await makeFixture(tree);
    const archive = await makeArchive(tree);
    const fromDirectory = await runJson([root, '--strict-no-railway']);
    const fromArchive = await runJson([archive, '--strict-no-railway']);
    assert.equal(fromArchive.code, 1);
    assert.equal(findingsWith(fromArchive.report, 'railway-host')[0]?.severity, 'fail');
    assert.deepEqual(findingKeys(fromArchive.report), findingKeys(fromDirectory.report));
  },
);

test('a tar of a clean tree still produces no findings after extraction', { skip: tarSkip }, async () => {
  const archive = await makeArchive(CLEAN_TREE, { gzip: false });
  const { code, report } = await runJson([archive, '--strict-no-railway']);
  assert.equal(code, 0);
  assert.equal(report.counts.fail, 0);
  assert.equal(report.textFilesScanned, Object.keys(CLEAN_TREE).length);
});

// ---- Finding 2: every path, target and diagnostic is redacted before output ------------------------------------

test('a secret in a file name is redacted from human and JSON output', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, [`keys/${FIXTURE_SECRET}.pem`]: 'not-a-real-key-body\n' });
  const { human, json } = await assertNoSecretInOutput([root], FIXTURE_SECRET, FIXTURE_SECRET_PARTS);
  assert.equal(human.code, 1);
  assert.equal(json.code, 1);
  const finding = findingsWith(JSON.parse(json.stdout), 'private-key-file')[0];
  assert.ok(finding, 'the private-key-file rule still fires with a redacted path');
  assert.match(finding.path, /^keys\/.*\.pem$/);
});

test('a secret in a directory name is redacted from human and JSON output', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    [`private-${FIXTURE_SECRET}/.env`]: 'EXPO_PUBLIC_APP_ENV=production\n',
  });
  const { json } = await assertNoSecretInOutput([root], FIXTURE_SECRET, FIXTURE_SECRET_PARTS);
  assert.equal(json.code, 1);
  assert.ok(findingsWith(JSON.parse(json.stdout), 'env-file')[0], 'the env-file rule still fires');
});

test('a secret in a tar member name is redacted, including the private-key finding', { skip: tarSkip }, async () => {
  const archive = await makeArchive({ ...CLEAN_TREE, [`ios/${FIXTURE_SECRET}.p8`]: 'not-a-real-key-body\n' });
  const { json } = await assertNoSecretInOutput([archive], FIXTURE_SECRET, FIXTURE_SECRET_PARTS);
  assert.equal(json.code, 1);
  assert.ok(findingsWith(JSON.parse(json.stdout), 'private-key-file')[0], 'the private-key-file rule still fires');
});

test('a secret in an unknown option is redacted from stderr', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const result = await runCli([root, `--${FIXTURE_SECRET}`]);
  assert.equal(result.code, 2);
  assert.ok(!result.stderr.includes(FIXTURE_SECRET), 'stderr does not echo the option');
  assert.ok(!result.stderr.includes('testfixtureValue'), 'stderr does not echo any part of the option');
});

test('a secret in an absolute --list entry is not printed in the path-escape diagnostic', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const listRoot = await makeFixture({ 'list.txt': `/tmp/${FIXTURE_SECRET}.txt\n` });
  const { json } = await assertNoSecretInOutput(
    [root, '--list', join(listRoot, 'list.txt')],
    FIXTURE_SECRET,
    FIXTURE_SECRET_PARTS,
  );
  assert.equal(json.code, 1);
  const [finding] = findingsWith(JSON.parse(json.stdout), 'path-escape');
  assert.equal(finding?.path, '--list line 1');
});

test('a secret in a missing --list entry is redacted from the incomplete-inspection finding', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const listRoot = await makeFixture({ 'list.txt': `missing-${FIXTURE_SECRET}.ts\n` });
  const { json } = await assertNoSecretInOutput(
    [root, '--list', join(listRoot, 'list.txt')],
    FIXTURE_SECRET,
    FIXTURE_SECRET_PARTS,
  );
  assert.equal(json.code, 1);
  assert.ok(findingsWith(JSON.parse(json.stdout), 'incomplete-inspection')[0], 'the missing entry is reported');
});

// ---- Finding 3: incomplete inspection is never a PASS ----------------------------------------------------------

test('a text file over 512 KiB with a secret at its beginning fails, it is not skipped', async () => {
  const body = `${FIXTURE_SECRET}\n${'const line = "ordinary text";\n'.repeat(30000)}`;
  const root = await makeFixture({ ...CLEAN_TREE, 'src/large.ts': body });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  const [finding] = findingsWith(report, 'openai-api-key');
  assert.equal(finding?.path, 'src/large.ts');
  assert.equal(finding?.line, 1);
});

test('a secret at the end of a large text file is found across chunk reads', async () => {
  const body = `${'const line = "ordinary text";\n'.repeat(20000)}${FIXTURE_SECRET}\n`;
  const root = await makeFixture({ ...CLEAN_TREE, 'src/large.ts': body });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'openai-api-key')[0]?.line, 20001);
});

test('a single unterminated line longer than one read window still finds a secret that spans the window edge', async () => {
  // The filler ends with a space so the secret starts on a word boundary; the secret then crosses the 64 KiB read edge.
  const filler = `${'a'.repeat(64 * 1024 - 10)} `;
  const root = await makeFixture({ ...CLEAN_TREE, 'src/minified.js': `${filler}${FIXTURE_SECRET}\n` });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'openai-api-key')[0]?.path, 'src/minified.js');
});

test('a text file over --max-file-bytes is an incomplete-inspection failure, never a pass', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, 'src/big.ts': `${'x'.repeat(4096)}\n` });
  const { code, report } = await runJson([root, '--max-file-bytes', '1024']);
  assert.equal(code, 1);
  assert.equal(report.passed, false);
  const [finding] = findingsWith(report, 'incomplete-inspection');
  assert.equal(finding?.severity, 'fail');
  assert.equal(finding?.path, 'src/big.ts');
});

test('a missing --list entry is an incomplete-inspection failure, not a warning', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const listRoot = await makeFixture({ 'list.txt': 'app.config.ts\nsrc/Gone.tsx\n' });
  const { code, report } = await runJson([root, '--list', join(listRoot, 'list.txt')]);
  assert.equal(code, 1);
  const [finding] = findingsWith(report, 'incomplete-inspection');
  assert.equal(finding?.severity, 'fail');
  assert.equal(finding?.path, 'src/Gone.tsx');
});

test('exceeding --max-files is an incomplete-inspection failure', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const { code, report } = await runJson([root, '--max-files', '2']);
  assert.equal(code, 1);
  assert.ok(findingsWith(report, 'incomplete-inspection')[0], 'the file budget is reported');
});

test('exceeding --max-total-bytes is an incomplete-inspection failure', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const { code, report } = await runJson([root, '--max-total-bytes', '10']);
  assert.equal(code, 1);
  assert.ok(findingsWith(report, 'incomplete-inspection')[0], 'the byte budget is reported');
});

test(
  'an archive over the --max-total-bytes budget is refused as incomplete, and not extracted',
  { skip: tarSkip },
  async () => {
    const archive = await makeArchive(CLEAN_TREE);
    const { code, report } = await runJson([archive, '--max-total-bytes', '10']);
    assert.equal(code, 1);
    assert.ok(findingsWith(report, 'incomplete-inspection')[0], 'the extraction budget is reported');
    assert.equal(report.textFilesScanned, 0, 'no member content is scanned');
  },
);

test('an archive with more files than --max-files is an incomplete-inspection failure', { skip: tarSkip }, async () => {
  const archive = await makeArchive(CLEAN_TREE);
  const { code, report } = await runJson([archive, '--max-files', '2']);
  assert.equal(code, 1);
  assert.ok(findingsWith(report, 'incomplete-inspection')[0]);
});

test('a binary file containing secret-like bytes is recorded as skipped-binary info, not a failure', async () => {
  const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${FIXTURE_SECRET}\n`)]);
  const root = await makeFixture({ ...CLEAN_TREE, 'assets/blob.dat': binary });
  const { code, report } = await runJson([root]);
  assert.equal(code, 0);
  const [info] = findingsWith(report, 'skipped-binary');
  assert.equal(info?.severity, 'info');
  assert.equal(info?.path, 'assets/blob.dat');
  assert.equal(report.skippedContent.binary, 1);
  assert.ok(!findingsWith(report, 'openai-api-key')[0], 'binary content is not text-scanned');
});

test('a large binary (over the text cap) is fine and recorded as skipped-binary', async () => {
  const binary = Buffer.alloc(2 * 1024 * 1024, 0);
  const root = await makeFixture({ ...CLEAN_TREE, 'assets/big.bin': binary });
  const { code, report } = await runJson([root, '--max-file-bytes', '1024']);
  assert.equal(code, 0);
  assert.equal(findingsWith(report, 'skipped-binary')[0]?.path, 'assets/big.bin');
});

test(
  'an unreadable text file is an incomplete-inspection failure, never a pass',
  { skip: isRoot ? 'root can read every file' : false },
  async () => {
    const root = await makeFixture({ ...CLEAN_TREE, 'src/locked.ts': `export const k = 1;\n` });
    await chmod(join(root, 'src/locked.ts'), 0o000);
    const { code, report } = await runJson([root]);
    assert.equal(code, 1);
    assert.equal(findingsWith(report, 'incomplete-inspection')[0]?.path, 'src/locked.ts');
  },
);

// ---- Finding 4: path containment for --list and archive members ------------------------------------------------

test('--list through an intermediate symlink to outside the target is a path-escape and is not read', async () => {
  const outside = await makeFixture({ 'config.ts': `export const k = "${FIXTURE_SECRET}";\n` });
  const root = await makeFixture(CLEAN_TREE);
  await symlink(outside, join(root, 'linked'), 'dir');
  const listRoot = await makeFixture({ 'list.txt': 'linked/config.ts\napp.config.ts\n' });
  const { code, report } = await runJson([root, '--list', join(listRoot, 'list.txt')]);
  assert.equal(code, 1);
  const [escape] = findingsWith(report, 'path-escape');
  assert.equal(escape?.severity, 'fail');
  assert.equal(escape?.path, 'linked/config.ts');
  assert.deepEqual(findingsWith(report, 'openai-api-key'), [], 'the file outside the target is not read');
  assert.equal(report.textFilesScanned, 1);
});

test('--list entries that are absolute or contain .. are path-escape failures', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const listRoot = await makeFixture({ 'list.txt': '/etc/hosts\n../outside.ts\n' });
  const { code, report } = await runJson([root, '--list', join(listRoot, 'list.txt')]);
  assert.equal(code, 1);
  assert.deepEqual(
    findingsWith(report, 'path-escape').map((finding) => finding.path),
    ['--list line 1', '--list line 2'],
  );
});

test(
  'a tar with a symlink member is an incomplete-inspection failure and is not extracted',
  { skip: tarSkip },
  async () => {
    const root = await makeFixture(CLEAN_TREE);
    await symlink('/etc', join(root, 'linked'));
    const archiveRoot = await makeFixture({});
    const archive = join(archiveRoot, 'upload.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', root, '.']).status, 0);
    const { code, report } = await runJson([archive]);
    assert.equal(code, 1);
    assert.equal(findingsWith(report, 'incomplete-inspection')[0]?.path, 'linked');
    assert.equal(report.textFilesScanned, 0);
  },
);

// ---- Finding 5: quoted and named secret assignments -------------------------------------------------------------

test('a JSON setting with a quoted CLERK_WEBHOOK_SIGNING_SECRET key and a literal value fails', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'config/settings.json': `{\n  "CLERK_WEBHOOK_SIGNING_SECRET": "${SIGNING_VALUE}"\n}\n`,
  });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(findingsWith(report, 'secret-assignment')[0]?.path, 'config/settings.json');
});

test('YAML, .env, TypeScript-object and single-quoted forms of named secrets fail', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'config/app.yaml': `CLERK_WEBHOOK_SIGNING_SECRET: "${SIGNING_VALUE}"\n`,
    'config/settings.env.example': `CLERK_WEBHOOK_SIGNING_SECRET=${SIGNING_VALUE}\n`,
    'src/settings.ts': `export const settings = { CLERK_WEBHOOK_SIGNING_SECRET: '${SIGNING_VALUE}' };\n`,
    'src/tokens.ts': `export const tokens = { 'apiToken': '${SIGNING_VALUE}' };\n`,
  });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  const paths = findingsWith(report, 'secret-assignment')
    .map((finding) => finding.path)
    .sort();
  assert.deepEqual(paths, ['config/app.yaml', 'config/settings.env.example', 'src/settings.ts', 'src/tokens.ts']);
});

test('TypeScript password schema calls are code expressions rather than literal credentials', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'packages/shared/src/schemas/user.schema.ts': [
      "import { z } from 'zod';",
      'export const loginSchema = z.object({',
      "  password: z.string().min(1, 'Password is required'),",
      '});',
      '',
    ].join('\n'),
  });
  const { code, report } = await runJson([root, '--strict-no-railway']);
  assert.equal(code, 0);
  assert.equal(report.passed, true);
  assert.deepEqual(findingsWith(report, 'secret-assignment'), []);
});

test('unquoted configuration and quoted code credentials retain literal-secret detection', async () => {
  const callLikeValue = ['credential', 'Factory(1234567890)'].join('');
  const root = await makeFixture({
    ...CLEAN_TREE,
    'config/unquoted.env.example': `PASSWORD=${SIGNING_VALUE}\nTOKEN=${callLikeValue}\n`,
    'config/unquoted.yaml': `PASSWORD: ${SIGNING_VALUE}\nTOKEN: ${callLikeValue}\n`,
    'src/quoted.ts': `export const config = { password: '${callLikeValue}' };\n`,
  });
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.deepEqual(
    findingsWith(report, 'secret-assignment').map(({ path, line }) => [path, line]),
    [
      ['config/unquoted.env.example', 1],
      ['config/unquoted.env.example', 2],
      ['config/unquoted.yaml', 1],
      ['config/unquoted.yaml', 2],
      ['src/quoted.ts', 1],
    ],
  );
  assert.ok(!JSON.stringify(report).includes(callLikeValue), 'credential values stay redacted');
});

test('placeholder values of named secrets do not fail', async () => {
  const root = await makeFixture({
    ...CLEAN_TREE,
    'config/placeholders.json': [
      '{',
      '  "CLERK_WEBHOOK_SIGNING_SECRET": "your-webhook-secret-1234",',
      '  "CLERK_SECRET_KEY": "<clerk-secret-key-1234567890>",',
      '  "OPENAI_API_KEY": "changeme-123456789012",',
      '  "LENCO_API_SECRET": "example-value-1234567890",',
      '  "AUTH_TOKEN": "xxxxxxxxxxxxxxxx1234"',
      '}',
      '',
    ].join('\n'),
  });
  const { code, report } = await runJson([root]);
  assert.equal(code, 0);
  assert.deepEqual(findingsWith(report, 'secret-assignment'), []);
});

// ---- Finding 6 is covered by the node_modules tests above -----------------------------------------------------------

// ---- Incomplete inspections are failures: unsupported entries, --list paths, symlinks, and empty sets ------------------

// A FIFO is created with mkfifo. It is never opened, so the run must finish quickly; the timeout makes a regression that
// blocks on it fail instead of hanging. The test records a skip reason where mkfifo is not available.
const FIFO_TIMEOUT_MS = 15000;

function makeFifo(path) {
  const made = spawnSync('mkfifo', [path]);
  return made.error ? { ok: false, reason: `mkfifo is not available: ${made.error.code}` } : { ok: made.status === 0 };
}

test('a FIFO in a directory upload set fails as an unsupported entry and is not opened', async (t) => {
  const root = await makeFixture(CLEAN_TREE);
  const fifo = makeFifo(join(root, 'src', 'config.ts'));
  if (!fifo.ok) {
    t.skip(fifo.reason ?? 'mkfifo could not create a FIFO on this machine');
    return;
  }
  const { code, report } = await runJson([root], { timeout: FIFO_TIMEOUT_MS });
  assert.equal(code, 1);
  assert.equal(report.passed, false);
  const [finding] = findingsWith(report, 'incomplete-inspection');
  assert.equal(finding?.severity, 'fail');
  assert.equal(finding?.reason, 'special-entry');
  assert.equal(finding?.path, 'src/config.ts');
});

test('a FIFO named in --list fails as an unsupported entry and is not opened', async (t) => {
  const root = await makeFixture(CLEAN_TREE);
  const fifo = makeFifo(join(root, 'config.ts'));
  if (!fifo.ok) {
    t.skip(fifo.reason ?? 'mkfifo could not create a FIFO on this machine');
    return;
  }
  const listRoot = await makeFixture({ 'list.txt': 'config.ts\n' });
  const { code, report } = await runJson([root, '--list', join(listRoot, 'list.txt')], { timeout: FIFO_TIMEOUT_MS });
  assert.equal(code, 1);
  const [finding] = findingsWith(report, 'incomplete-inspection');
  assert.equal(finding?.reason, 'special-entry');
  assert.equal(finding?.path, 'config.ts');
});

test('a --list entry with a trailing slash is a clear failure, not a silently skipped directory', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const listRoot = await makeFixture({ 'list.txt': 'app.config.ts\nmissing.ts/\n' });
  const { code, report } = await runJson([root, '--list', join(listRoot, 'list.txt')]);
  assert.equal(code, 1);
  assert.equal(report.passed, false);
  const [finding] = findingsWith(report, 'incomplete-inspection');
  assert.equal(finding?.severity, 'fail');
  assert.equal(finding?.reason, 'listed-entry-not-file');
  assert.equal(finding?.path, '--list line 2');
  assert.match(finding?.message ?? '', /directory/);
});

test('a --list entry that names an existing directory is a failure and its contents are not silently passed', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const listRoot = await makeFixture({ 'list.txt': 'src\n' });
  const { code, report } = await runJson([root, '--list', join(listRoot, 'list.txt')]);
  assert.equal(code, 1);
  const [finding] = findingsWith(report, 'incomplete-inspection');
  assert.equal(finding?.reason, 'special-entry');
  assert.equal(finding?.path, 'src');
});

test('an internal symlink in --list is followed, and the secret in its target is found under the link path', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, 'src/config.ts': `export const k = "${FIXTURE_SECRET}";\n` });
  await symlink(join(root, 'src', 'config.ts'), join(root, 'link.ts'), 'file');
  const listRoot = await makeFixture({ 'list.txt': 'link.ts\n' });
  const args = [root, '--list', join(listRoot, 'list.txt')];
  const { code, report } = await runJson(args);
  assert.equal(code, 1);
  assert.equal(report.textFilesScanned, 1, 'the link target is text-scanned');
  const [hit] = findingsWith(report, 'openai-api-key');
  assert.equal(hit?.path, 'link.ts');
  assert.equal(hit?.severity, 'fail');
  assert.deepEqual(findingsWith(report, 'symlink-entry'), [], 'a followed link is not a warning');
  await assertNoSecretInOutput(args, FIXTURE_SECRET, FIXTURE_SECRET_PARTS);
});

test('an internal symlink in a directory walk is followed, so a clean target passes and is scanned', async () => {
  const root = await makeFixture(CLEAN_TREE);
  await symlink(join(root, 'src', 'App.tsx'), join(root, 'Alias.tsx'), 'file');
  const { code, report } = await runJson([root]);
  assert.equal(code, 0);
  assert.equal(report.passed, true);
  assert.equal(report.textFilesScanned, Object.keys(CLEAN_TREE).length + 1, 'the link is scanned through its target');
});

test('an internal symlink in a directory walk that leads to a secret fails at the link path', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, 'src/config.ts': `export const k = "${FIXTURE_SECRET}";\n` });
  await symlink(join(root, 'src', 'config.ts'), join(root, 'Alias.ts'), 'file');
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.ok(
    findingsWith(report, 'openai-api-key').some((finding) => finding.path === 'Alias.ts'),
    'the secret is reported under the link path',
  );
});

test('a symlink in the upload set that points outside the target is a path-escape failure, not a warning', async () => {
  const outside = await makeFixture({ 'config.ts': `export const k = "${FIXTURE_SECRET}";\n` });
  const root = await makeFixture(CLEAN_TREE);
  await symlink(join(outside, 'config.ts'), join(root, 'escape.ts'), 'file');
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  const [escape] = findingsWith(report, 'path-escape');
  assert.equal(escape?.severity, 'fail');
  assert.equal(escape?.path, 'escape.ts');
  assert.deepEqual(findingsWith(report, 'symlink-entry'), [], 'an external link is not only a warning');
  assert.deepEqual(findingsWith(report, 'openai-api-key'), [], 'the file outside the target is not read');
});

test('a symlink to a directory in the upload set fails as an unsupported entry', async () => {
  const root = await makeFixture(CLEAN_TREE);
  await symlink(join(root, 'src'), join(root, 'srcalias'), 'dir');
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  const [finding] = findingsWith(report, 'incomplete-inspection');
  assert.equal(finding?.reason, 'special-entry');
  assert.equal(finding?.path, 'srcalias');
});

test('an empty directory upload set fails, because zero files were inspected', async () => {
  const root = await makeFixture({});
  const { code, report } = await runJson([root]);
  assert.equal(code, 1);
  assert.equal(report.filesInspected, 0);
  const [finding] = findingsWith(report, 'incomplete-inspection');
  assert.equal(finding?.reason, 'no-files-inspected');
  assert.equal(finding?.severity, 'fail');
});

test('a --list file with no entries fails, because zero files were inspected', async () => {
  const root = await makeFixture(CLEAN_TREE);
  const listRoot = await makeFixture({ 'list.txt': '# nothing listed\n\n' });
  const { code, report } = await runJson([root, '--list', join(listRoot, 'list.txt')]);
  assert.equal(code, 1);
  assert.equal(report.filesInspected, 0);
  assert.equal(findingsWith(report, 'incomplete-inspection')[0]?.reason, 'no-files-inspected');
});

// ---- Discovered files that disappear, and the check-to-open race ------------------------------------------------------
//
// Race fixtures run inside a child process. The child imports the verifier, wraps one of its filesystem calls (fsOps)
// and changes the victim file right after that call returns. Each child has a timeout, so a verifier that blocks on a
// FIFO fails the test instead of hanging the suite. The child reports the findings and every open() flag it used.

const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK_FLAG = fsConstants.O_NONBLOCK ?? 0;
const RACE_CHILD = `
import { execFileSync } from 'node:child_process';
import { rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
const spec = JSON.parse(process.env.RACE_SPEC);
const { fsOps, inspect, buildReport } = await import(spec.scriptUrl);
const openFlags = [];
const originalOpen = fsOps.open;
fsOps.open = (path, flags) => {
  openFlags.push(flags);
  return originalOpen(path, flags);
};
if (spec.noFollowSupported === false) {
  fsOps.noFollowFlags = () => undefined;
}
const suffix = join(sep, ...spec.rel.split('/'));
const matches = (path) => String(path).endsWith(suffix);
// Each action changes the exact path that the hooked call received, so it works for archive extraction paths too.
const actions = {
  remove: (victim) => unlink(victim),
  'to-external-symlink': async (victim) => {
    await unlink(victim);
    await symlink(spec.external, victim);
  },
  'to-fifo': async (victim) => {
    await unlink(victim);
    execFileSync('mkfifo', [victim]);
  },
  'to-other-file': async (victim) => {
    await unlink(victim);
    await writeFile(victim, spec.replacementText);
  },
  'dir-to-external-link': async (victim) => {
    const parent = dirname(victim);
    await rename(parent, parent + '-moved');
    await symlink(spec.externalDir, parent);
  },
};
if (spec.hook) {
  const original = fsOps[spec.hook];
  let fired = false;
  fsOps[spec.hook] = async (path, ...rest) => {
    const result = await original(path, ...rest);
    if (!fired && matches(path)) {
      fired = true;
      await actions[spec.action](String(path));
    }
    return result;
  };
}
const options = {
  limits: { maxFiles: 20000, maxTotalBytes: 1024 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024 },
  strictNoRailway: false,
  list: spec.list,
};
const { mode, analysis } = await inspect(spec.target, options);
process.stdout.write(JSON.stringify({ report: buildReport(spec.target, mode, options, analysis), openFlags }));
`;

const RACE_TIMEOUT_MS = 15000;

async function runRace(spec) {
  const env = { ...process.env, RACE_SPEC: JSON.stringify({ ...spec, scriptUrl: pathToFileURL(scriptPath).href }) };
  return new Promise((done) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', RACE_CHILD],
      { env, timeout: RACE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        let parsed = null;
        try {
          parsed = JSON.parse(String(stdout));
        } catch {
          parsed = null;
        }
        done({
          timedOut: error?.killed === true,
          stdout: String(stdout),
          stderr: String(stderr),
          report: parsed?.report ?? null,
          openFlags: parsed?.openFlags ?? [],
        });
      },
    );
  });
}

const VICTIM_REL = 'src/victim.ts';
const VICTIM_TREE = { ...CLEAN_TREE, [VICTIM_REL]: 'export const victim = 1;\n' };
const mkfifoSkip = spawnSync('mkfifo', ['/dev/null']).error ? 'mkfifo is not available' : false;

test('a file that disappears after discovery and resolution fails as incomplete-inspection, not a pass', async () => {
  const root = await makeFixture(VICTIM_TREE);
  const run = await runRace({ target: root, victimRoot: root, rel: VICTIM_REL, hook: 'realpath', action: 'remove' });
  assert.equal(run.report?.passed, false);
  const [finding] = findingsWith(run.report, 'incomplete-inspection');
  assert.equal(finding?.severity, 'fail');
  assert.equal(finding?.reason, 'missing');
  assert.equal(finding?.path, VICTIM_REL);
});

test('a file that disappears between lstat and open fails as incomplete-inspection, not a pass', async () => {
  const root = await makeFixture(VICTIM_TREE);
  const run = await runRace({ target: root, victimRoot: root, rel: VICTIM_REL, hook: 'lstat', action: 'remove' });
  assert.equal(run.report?.passed, false);
  assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'missing');
});

test('a --list entry that disappears after resolution fails with the listed-file-missing reason', async () => {
  const root = await makeFixture(VICTIM_TREE);
  const listRoot = await makeFixture({ 'list.txt': `${VICTIM_REL}\n` });
  const run = await runRace({
    target: root,
    victimRoot: root,
    rel: VICTIM_REL,
    hook: 'realpath',
    action: 'remove',
    list: join(listRoot, 'list.txt'),
  });
  assert.equal(run.report?.passed, false);
  assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'listed-file-missing');
});

test(
  'an archive member that disappears from the extraction directory fails as incomplete-inspection',
  { skip: tarSkip },
  async () => {
    const archive = await makeArchive(VICTIM_TREE);
    const run = await runRace({
      target: archive,
      victimRoot: archive,
      rel: VICTIM_REL,
      hook: 'realpath',
      action: 'remove',
    });
    assert.equal(run.report?.passed, false);
    assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'missing');
  },
);

test('a secret in the name of a file that disappears is redacted from the output', async () => {
  const secretRel = `src/${FIXTURE_SECRET}.ts`;
  const root = await makeFixture({ ...CLEAN_TREE, [secretRel]: 'export const v = 1;\n' });
  const run = await runRace({ target: root, victimRoot: root, rel: secretRel, hook: 'realpath', action: 'remove' });
  assert.equal(run.report?.passed, false);
  assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'missing');
  assert.ok(!run.stdout.includes(FIXTURE_SECRET), 'the full secret is not printed');
  assert.ok(!run.stdout.includes(FIXTURE_SECRET_PARTS[1]), 'no part of the secret is printed');
});

test('a file replaced by a symlink to an outside file between lstat and open is never read and fails', async () => {
  const outside = await makeFixture({ 'outside.ts': `export const k = "${FIXTURE_SECRET}";\n` });
  const root = await makeFixture(VICTIM_TREE);
  const run = await runRace({
    target: root,
    victimRoot: root,
    rel: VICTIM_REL,
    hook: 'lstat',
    action: 'to-external-symlink',
    external: join(outside, 'outside.ts'),
  });
  assert.equal(run.report?.passed, false);
  assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'changed-during-inspection');
  assert.deepEqual(findingsWith(run.report, 'openai-api-key'), [], 'the external bytes are not scanned');
  assert.ok(!run.stdout.includes(FIXTURE_SECRET), 'the external secret is not printed');
  assert.ok(!run.stdout.includes(FIXTURE_SECRET_PARTS[1]), 'no part of the external secret is printed');
});

test('a parent directory replaced by a link to an outside directory after resolution is never read and fails', async () => {
  const outsideDir = await makeFixture({ 'victim.ts': `export const k = "${FIXTURE_SECRET}";\n` });
  const root = await makeFixture(VICTIM_TREE);
  const run = await runRace({
    target: root,
    victimRoot: root,
    rel: VICTIM_REL,
    hook: 'realpath',
    action: 'dir-to-external-link',
    externalDir: outsideDir,
  });
  assert.equal(run.report?.passed, false);
  assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'changed-during-inspection');
  assert.deepEqual(
    findingsWith(run.report, 'openai-api-key'),
    [],
    'the file behind the outside directory is not scanned',
  );
  assert.ok(!run.stdout.includes(FIXTURE_SECRET), 'the external secret is not printed');
});

test('a secret in the name of a file replaced by an outside symlink is redacted and fails', async () => {
  const outside = await makeFixture({ 'outside.ts': `export const k = "${FIXTURE_SECRET}";\n` });
  const secretRel = `src/${FIXTURE_SECRET}.ts`;
  const root = await makeFixture({ ...CLEAN_TREE, [secretRel]: 'export const v = 1;\n' });
  const run = await runRace({
    target: root,
    victimRoot: root,
    rel: secretRel,
    hook: 'lstat',
    action: 'to-external-symlink',
    external: join(outside, 'outside.ts'),
  });
  assert.equal(run.report?.passed, false);
  assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'changed-during-inspection');
  assert.ok(!run.stdout.includes(FIXTURE_SECRET), 'the full secret is not printed');
});

test('a file replaced by a FIFO between lstat and open does not block and fails', { skip: mkfifoSkip }, async () => {
  const root = await makeFixture(VICTIM_TREE);
  const run = await runRace({ target: root, victimRoot: root, rel: VICTIM_REL, hook: 'lstat', action: 'to-fifo' });
  assert.equal(run.timedOut, false, 'the verifier does not block on the FIFO');
  assert.equal(run.report?.passed, false);
  assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'changed-during-inspection');
});

test('a file replaced by a different regular file between lstat and open fails', async () => {
  const root = await makeFixture(VICTIM_TREE);
  const run = await runRace({
    target: root,
    victimRoot: root,
    rel: VICTIM_REL,
    hook: 'lstat',
    action: 'to-other-file',
    replacementText: 'export const replaced = 2;\n',
  });
  assert.equal(run.report?.passed, false);
  assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'changed-during-inspection');
});

test('every text file is opened with a no-follow, non-blocking flag set when nothing changes', async () => {
  const root = await makeFixture(VICTIM_TREE);
  const run = await runRace({ target: root, victimRoot: root, rel: VICTIM_REL });
  assert.equal(run.report?.passed, true);
  assert.equal(run.openFlags.length, Object.keys(VICTIM_TREE).length);
  assert.notEqual(NOFOLLOW_FLAG, 0, 'this platform defines O_NOFOLLOW');
  assert.notEqual(NONBLOCK_FLAG, 0, 'this platform defines O_NONBLOCK');
  for (const flags of run.openFlags) {
    assert.equal(typeof flags, 'number', 'the open flags are numeric O_* flags');
    assert.notEqual(flags & NOFOLLOW_FLAG, 0, 'the open does not follow symbolic links');
    assert.notEqual(flags & NONBLOCK_FLAG, 0, 'the open cannot block on a FIFO');
  }
});

test('a platform without no-follow open support fails closed and reads no file content', async () => {
  const root = await makeFixture({ ...CLEAN_TREE, 'src/config.ts': `export const k = "${FIXTURE_SECRET}";\n` });
  const run = await runRace({ target: root, victimRoot: root, rel: 'src/config.ts', noFollowSupported: false });
  assert.equal(run.report?.passed, false);
  assert.equal(findingsWith(run.report, 'incomplete-inspection')[0]?.reason, 'no-nofollow');
  assert.deepEqual(findingsWith(run.report, 'openai-api-key'), [], 'no content is read without the protection');
  assert.ok(!run.stdout.includes(FIXTURE_SECRET), 'the file content is not printed');
});

// Entry-point regression tests. The CLI must run however it is invoked, and must not run when the module is imported.
// Each run uses a fixture with a .env file, so a run that silently skips inspection shows up as exit 0 with no output.
function runNode(nodeArgs, { env = {} } = {}) {
  return new Promise((done) => {
    const childEnv = { ...process.env, NODE_OPTIONS: '', ...env };
    execFile(process.execPath, nodeArgs, { timeout: 20000, env: childEnv }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function makeScriptSymlink() {
  const linkRoot = await makeFixture({});
  const link = join(linkRoot, 'verify-eas-archive-link.mjs');
  await symlink(scriptPath, link);
  return link;
}

const ENV_FIXTURE = { ...CLEAN_TREE, '.env': 'EXPO_PUBLIC_APP_ENV=production\n' };

function assertEnvFindingRun(run) {
  assert.equal(run.code, 1, 'the run fails on the .env file');
  assert.match(run.stdout, /Result: FAIL/, 'the CLI prints its report');
  assert.match(run.stdout, /\.env/, 'the report names the .env file');
}

test('direct invocation of the script runs the CLI and fails on a .env file', async () => {
  const root = await makeFixture(ENV_FIXTURE);
  assertEnvFindingRun(await runNode([scriptPath, root]));
});

test('invocation through a symlink to the script runs the CLI and fails on a .env file', async () => {
  const root = await makeFixture(ENV_FIXTURE);
  const link = await makeScriptSymlink();
  assertEnvFindingRun(await runNode([link, root]));
});

test('a symlink invocation with --preserve-symlinks-main runs the CLI and fails on a .env file', async () => {
  const root = await makeFixture(ENV_FIXTURE);
  const link = await makeScriptSymlink();
  assertEnvFindingRun(await runNode(['--preserve-symlinks-main', link, root]));
});

test('a symlink invocation with NODE_OPTIONS=--preserve-symlinks-main runs the CLI and fails on a .env file', async () => {
  const root = await makeFixture(ENV_FIXTURE);
  const link = await makeScriptSymlink();
  assertEnvFindingRun(await runNode([link, root], { env: { NODE_OPTIONS: '--preserve-symlinks-main' } }));
});

test('importing the module from another script does not run the CLI', async () => {
  const root = await makeFixture(ENV_FIXTURE);
  const importer = join(await makeFixture({}), 'importer.mjs');
  await writeFile(
    importer,
    `import ${JSON.stringify(pathToFileURL(scriptPath).href)};\nconsole.log('imported only');\n`,
  );
  const run = await runNode([importer, root]);
  assert.equal(run.code, 0, 'the importing script exits normally');
  assert.equal(run.stdout, 'imported only\n', 'the verifier prints nothing when it is only imported');
});

test('when the entry point cannot be resolved the CLI still runs and fails closed', async () => {
  const moduleUrl = pathToFileURL(scriptPath).href;
  const run = await runNode(['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`]);
  assert.equal(run.code, 2, 'the CLI runs and reports missing arguments, instead of exiting 0 silently');
  assert.match(run.stderr, /Usage: node scripts\/verify-eas-archive\.mjs/);
});
