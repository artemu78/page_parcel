import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = readFileSync(new URL('../../scripts/deploy.sh', import.meta.url), 'utf8');
for (const target of ['webhook', 'worker', 'all']) {
  test(`${target}: every registry build disables provenance`, () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-registry-test-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'bin'));
      writeFileSync(join(root, 'scripts/deploy.sh'), script);
      writeFileSync(join(root, 'package.json'), '{"version":"0.0.0"}');
      writeFileSync(join(root, 'bin/docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_CALLS"\n', { mode: 0o755 });
      writeFileSync(join(root, 'bin/terraform'), '#!/bin/sh\ncase "$*" in *registry_id*) echo test-registry;; esac\n', { mode: 0o755 });
      const log = join(root, 'calls');
      const result = spawnSync('bash', [join(root, 'scripts/deploy.sh'), target], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, DEPLOY_TEST_CALLS: log },
      });
      assert.equal(result.status, 0, result.stderr);
      const builds = readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('build '));
      assert.equal(builds.length, target === 'all' ? 2 : 1);
      for (const build of builds) {
        assert.match(build, /--platform linux\/amd64(?: |$)/);
        assert.match(build, /--provenance=false(?: |$)/, 'Default provenance recreates the registry-rejected index');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
