const THUMBNAIL_SCHEME = 'nine-thumb';
const LIBRARY_SESSION = 'nine-library-ui';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const imageRoute = /^nine-thumb:\/\/library\/([a-f0-9]{24})\/(legacy|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;

function thumbnailRequestHandler(readImage) {
  const reject = (status, headers = {}) => new Response(null, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  });

  return request => {
    if (request.method !== 'GET') return reject(405, { allow: 'GET' });
    const route = imageRoute.exec(request.url);
    if (!route) return reject(404);
    const [, id, revision] = route;
    const image = readImage(id, revision);
    if (!image || !IMAGE_TYPES.has(image.mime) || !(image.bytes instanceof Uint8Array) || !image.bytes.byteLength) return reject(404);

    const etag = `"${revision}"`;
    const headers = { 'cache-control': 'private, no-cache', etag, 'x-content-type-options': 'nosniff' };
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return new Response(image.bytes, { headers: { ...headers, 'content-type': image.mime } });
  };
}

module.exports = { THUMBNAIL_SCHEME, LIBRARY_SESSION, thumbnailRequestHandler };
