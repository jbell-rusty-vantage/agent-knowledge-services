import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from '../../.agent-docs/vendor/js-yaml.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

for (const name of ['agent-maintenance.yml', 'maintenance-checks.yml']) {
  test(`${name} rejects duplicate YAML keys and has parseable inline scripts`, () => {
    const workflow = yaml.load(readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8'));
    assert.equal(workflow.permissions.contents, 'read');
    assert.ok(Object.keys(workflow.jobs).length);
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.with?.script) new AsyncFunction('github', 'context', 'core', step.with.script);
      }
    }
  });
}
