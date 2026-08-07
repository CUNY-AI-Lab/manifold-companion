import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repoDir = fileURLToPath(new URL('..', import.meta.url));

async function readRepoFile(relativePath) {
  return readFile(join(repoDir, relativePath), 'utf8');
}

function capture(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label} is missing`);
  return match[1];
}

test('deployment files share one production contract', async () => {
  const [setup, service, nginx, claude, productionPlan, implementationPlan] = await Promise.all([
    readRepoFile('deploy/setup.sh'),
    readRepoFile('deploy/manifold-companion.service'),
    readRepoFile('deploy/nginx.conf'),
    readRepoFile('CLAUDE.md'),
    readRepoFile('docs/plans/2026-02-24-production-deployment.md'),
    readRepoFile('docs/plans/2026-02-24-implementation-plan.md'),
  ]);

  const appDir = capture(setup, /^APP_DIR="([^"]+)"$/m, 'setup app directory');
  const dataDir = capture(setup, /^DATA_DIR="([^"]+)"$/m, 'setup data directory');
  const setupUser = capture(setup, /^APP_USER="([^"]+)"$/m, 'setup service user');
  const setupPort = capture(setup, /^PORT=([0-9]+)$/m, 'setup port');
  const serviceUser = capture(service, /^User=(.+)$/m, 'systemd service user');
  const serviceDir = capture(service, /^WorkingDirectory=(.+)$/m, 'systemd working directory');
  const serviceEnv = capture(service, /^EnvironmentFile=(.+)$/m, 'systemd environment file');
  const nginxPort = capture(nginx, /proxy_pass http:\/\/127\.0\.0\.1:(\d+)\//, 'nginx upstream port');
  const documentedPort = capture(claude, /^\*\*Port\*\*: `([0-9]+)`/m, 'documented production port');

  assert.equal(appDir, '/data/manifold-companion');
  assert.equal(dataDir, '$APP_DIR/data');
  assert.equal(serviceDir, appDir);
  assert.equal(serviceEnv, `${appDir}/.env`);
  assert.equal(serviceUser, setupUser);
  assert.equal(setupPort, nginxPort);
  assert.equal(nginxPort, documentedPort);
  assert.match(productionPlan, /PORT=3003/);
  assert.match(implementationPlan, /Local development only/);

  for (const [label, source] of [
    ['setup script', setup],
    ['production plan', productionPlan],
    ['implementation plan', implementationPlan],
  ]) {
    assert.doesNotMatch(source, /\/opt\/manifold-companion|www-data|127\.0\.0\.1:3000/, `${label} retains the retired layout`);
  }

  assert.doesNotMatch(claude, /--exclude=['"]\*\.png['"]/, 'archive rule excludes runtime PNG assets');
});

test('the deployment archive retains built runtime PNG assets', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'manifold-companion-archive-'));
  const archiveDir = await mkdtemp(join(tmpdir(), 'manifold-companion-archive-output-'));
  const archivePath = join(archiveDir, 'manifold-companion.tar.gz');
  const logoPath = join(fixtureDir, 'client/dist/images/cail-logo-horizontal.png');

  try {
    await mkdir(join(fixtureDir, 'client/dist/images'), { recursive: true });
    await mkdir(join(fixtureDir, 'node_modules/example'), { recursive: true });
    await mkdir(join(fixtureDir, 'data'), { recursive: true });
    await writeFile(logoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(fixtureDir, 'README.md'), 'fixture');
    await writeFile(join(fixtureDir, 'node_modules/example/drop.png'), 'ignored');
    await writeFile(join(fixtureDir, 'data/drop.png'), 'ignored');

    await execFileAsync('tar', [
      'czf', archivePath,
      '--exclude=node_modules',
      '--exclude=data',
      '--exclude=.env',
      '--exclude=.git',
      '--exclude=.playwright-mcp',
      '.',
    ], { cwd: fixtureDir });

    const { stdout } = await execFileAsync('tar', ['tzf', archivePath]);
    assert.match(stdout, /client\/dist\/images\/cail-logo-horizontal\.png/);
    assert.doesNotMatch(stdout, /node_modules\/example\/drop\.png/);
    assert.doesNotMatch(stdout, /data\/drop\.png/);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(archiveDir, { recursive: true, force: true });
  }
});
