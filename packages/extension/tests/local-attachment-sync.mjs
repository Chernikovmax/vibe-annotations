// Optional MCP sync must never advertise extension-only image references.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(join(process.env.ANGULAR_DEPS || '/tmp/va-stage1-ng20', 'package.json'));
const { build } = require('esbuild');
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { outputFiles } = await build({ entryPoints: [join(extension, 'lib/background/api-sync.js')], bundle: true, write: false, format: 'esm', platform: 'node' });
let data = { annotations: [], deletedAnnotationIds: [] };
globalThis.chrome = {
  storage: { local: {
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])),
    set: async next => Object.assign(data, next),
  } },
  tabs: { query: async () => [] },
  runtime: { getManifest: () => ({ version: '2.2.0' }) },
};
let server = [], payloads = [];
globalThis.fetch = async (_url, options = {}) => {
  if (options.body) payloads.push(JSON.parse(options.body));
  return { ok: true, json: async () => ({ success: true, annotations: server }) };
};
const api = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const local = {
  id: 'annotation-a', url: 'http://localhost/a', updated_at: '2026-11-01',
  attachments: [{ id: 'secret-local-id', local_only: true, kind: 'capture', capture_mode: 'region' }, { id: 'legacy-server-image', kind: 'user' }],
};
data.annotations = [local];
await api.saveOne(local);
await api.syncAll([local]);
server = [{ ...local, updated_at: '2026-11-02', attachments: [{ id: 'secret-local-id', kind: 'user' }, { id: 'legacy-server-image', kind: 'user' }] }];
await api.smartSync(fn => fn());
assert.equal(data.annotations[0].attachments.find(a => a.id === 'secret-local-id').local_only, true);
server = [];
await api.smartSync(fn => fn());
assert.equal(data.annotations.length, 1);
assert.equal((await api.fetchAnnotations('http://localhost/a')).length, 1);
assert.equal((await api.fetchAnnotations('http://localhost/b')).length, 0);
for (const body of payloads) {
  assert.ok(!JSON.stringify(body).includes('secret-local-id'));
  assert.ok(JSON.stringify(body).includes('legacy-server-image'));
}
console.log('PASS saveOne, syncAll, smartSync exclude local-only refs; remote updates/missing rows retain local captures; URL scope retained');
