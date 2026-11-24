const test = require('node:test');
const assert = require('node:assert/strict');
const { thumbnailRequestHandler } = require('../electron/thumbnail-protocol.cjs');

const id = '1234567890abcdef12345678';
const revision = '19fd080f-9083-4b4d-b2be-970617b9d510';
const url = `nine-thumb://library/${id}/${revision}`;

test('valid thumbnail route returns raw image bytes, private revalidation and the MIME type', async () => {
  const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const handle = thumbnailRequestHandler((modelId, imageRevision) => {
    assert.equal(modelId, id);
    assert.equal(imageRevision, revision);
    return { mime: 'image/png', bytes };
  });
  const response = handle(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-cache');
  assert.equal(response.headers.get('etag'), `"${revision}"`);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('revalidation does not return stale bytes after replacement or deletion', () => {
  let active = revision;
  const handle = thumbnailRequestHandler((_, requestedRevision) => requestedRevision === active
    ? { mime: 'image/webp', bytes: Uint8Array.of(1) } : null);
  const request = new Request(url, { headers: { 'if-none-match': `"${revision}"` } });
  assert.equal(handle(request).status, 304);
  active = 'legacy';
  const stale = handle(request);
  assert.equal(stale.status, 404);
  assert.equal(stale.headers.get('cache-control'), 'no-store');
  assert.equal(handle(new Request(`nine-thumb://library/${id}/legacy`)).status, 200);
  active = null;
  assert.equal(handle(new Request(`nine-thumb://library/${id}/legacy`)).status, 404);
});

test('malformed routes and non-image methods never call the library', () => {
  let calls = 0;
  const handle = thumbnailRequestHandler(() => { calls++; });
  for (const badUrl of [
    `nine-thumb://other/${id}/${revision}`,
    `nine-thumb://library:8080/${id}/${revision}`,
    `nine-thumb://user@library/${id}/${revision}`,
    `nine-thumb://library/%2F${id}/${revision}`,
    `nine-thumb://library/${id}/%2e%2e%2fsecret`,
    `nine-thumb://library/${id}/${revision}/other`,
    `${url}?extra`,
    `${url}#extra`,
    `nine-thumb://library/${id}`,
    `file://library/${id}/${revision}`,
  ]) assert.equal(handle({ method: 'GET', url: badUrl, headers: new Headers() }).status, 404, badUrl);
  const post = handle(new Request(url, { method: 'POST' }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
  assert.equal(calls, 0);
});

test('unknown data types and empty thumbnails are refused without exposing the payload', () => {
  for (const invalid of [null, { mime: 'text/html', bytes: Uint8Array.of(1) },
    { mime: 'image/svg+xml', bytes: Uint8Array.of(1) }, { mime: 'image/png', bytes: Uint8Array.of() },
    { mime: 'image/png', bytes: 'image data' }]) {
    const handle = thumbnailRequestHandler(() => invalid);
    const response = handle(new Request(url));
    assert.equal(response.status, 404);
    assert.equal(response.body, null);
  }
});
