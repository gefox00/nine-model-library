const fs = require('node:fs/promises');
const { promisify } = require('node:util');
const { crc32, inflateRaw } = require('node:zlib');

const inflate = promisify(inflateRaw);
const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 4 * 1024 * 1024;
const END_RECORD_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function readRange(file, offset, length, signal) {
  signal?.throwIfAborted();
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(buffer, done, length - done, offset + done);
    signal?.throwIfAborted();
    if (!bytesRead) return null;
    done += bytesRead;
  }
  return buffer;
}

async function locateDirectory(file, size, signal) {
  if (!Number.isSafeInteger(size) || size < END_RECORD_BYTES) return null;
  const footer = await readRange(file, size - END_RECORD_BYTES, END_RECORD_BYTES, signal);
  if (!footer) return null;
  // For a ZIP without a comment, only read the fixed-size end record.
  if (footer.readUInt32LE(0) === END_SIGNATURE && footer.readUInt16LE(20) === 0) {
    const directory = directoryRecord(footer, 0, size - END_RECORD_BYTES);
    if (directory) return directory;
  }
  const tailSize = Math.min(size, END_RECORD_BYTES + 0xffff);
  const tailStart = size - tailSize;
  const tail = await readRange(file, tailStart, tailSize, signal);
  if (!tail) return null;
  for (let end = tailSize - END_RECORD_BYTES; end >= 0; end--) {
    if (tail.readUInt32LE(end) !== END_SIGNATURE ||
        end + END_RECORD_BYTES + tail.readUInt16LE(end + 20) !== tailSize) continue;
    const directory = directoryRecord(tail, end, tailStart + end);
    if (directory) return directory;
  }
  return null;
}

function directoryRecord(buffer, end, offset) {
  const files = buffer.readUInt16LE(end + 10);
  const length = buffer.readUInt32LE(end + 12);
  const start = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 ||
      buffer.readUInt16LE(end + 8) !== files || !files || files > MAX_FILES ||
      length < files * CENTRAL_HEADER_BYTES || length > MAX_DIRECTORY_BYTES ||
      start === 0xffffffff || start + length !== offset) return null;
  return { files, length, start };
}

function imageRank(name) {
  const parts = name.split('/');
  if (/[\\:\x00-\x1f]/.test(name) || parts.some(part => !part || part === '.' || part === '..')) return null;
  if (/^Metadata\/plate_1\.png$/i.test(name)) return 0;
  const filename = parts.at(-1);
  if (/^thumbnail_3mf\.png$/i.test(filename)) return 1;
  if (/thumbnail/i.test(filename)) return 2;
  if (/^plate_\d/i.test(filename)) return 3;
  return null;
}

function chooseImage(buffer, { files, start }) {
  let position = 0;
  let best = null;
  for (let index = 0; index < files; index++) {
    if (position + CENTRAL_HEADER_BYTES > buffer.length || buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) return null;
    const nameStart = position + CENTRAL_HEADER_BYTES;
    const nameEnd = nameStart + buffer.readUInt16LE(position + 28);
    const next = nameEnd + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32);
    if (next > buffer.length) return null;
    const nameBytes = buffer.subarray(nameStart, nameEnd);
    const name = nameBytes.toString('utf8');
    const type = name.match(/\.(png|jpe?g)$/i)?.[1]?.toLowerCase();
    const rank = type ? imageRank(name) : null;
    if (rank !== null && (!best || rank < best.rank)) {
      const flags = buffer.readUInt16LE(position + 8);
      const method = buffer.readUInt16LE(position + 10);
      const crc = buffer.readUInt32LE(position + 16);
      const packed = buffer.readUInt32LE(position + 20);
      const unpacked = buffer.readUInt32LE(position + 24);
      const offset = buffer.readUInt32LE(position + 42);
      // Allow UTF-8, a data descriptor, and DEFLATE level flags.
      const allowedFlags = 0x0808 | (method === 8 ? 0x0006 : 0);
      if (buffer.readUInt16LE(position + 34) === 0 && !(flags & ~allowedFlags) &&
          packed > 0 && packed <= MAX_IMAGE_BYTES && unpacked > 0 && unpacked <= MAX_IMAGE_BYTES &&
          (method === 8 || (method === 0 && packed === unpacked)) &&
          offset + LOCAL_HEADER_BYTES + packed <= start) {
        best = { nameBytes, type, rank, flags, method, crc, packed, unpacked, offset };
      }
    }
    position = next;
  }
  return position === buffer.length ? best : null;
}

async function entryData(file, image, directoryStart, signal) {
  const header = await readRange(file, image.offset, LOCAL_HEADER_BYTES, signal);
  if (!header || header.readUInt32LE(0) !== LOCAL_SIGNATURE ||
      header.readUInt16LE(6) !== image.flags || header.readUInt16LE(8) !== image.method ||
      header.readUInt16LE(26) !== image.nameBytes.length) return null;
  const descriptor = (image.flags & 8) !== 0;
  for (const [offset, value] of [[14, image.crc], [18, image.packed], [22, image.unpacked]]) {
    const field = header.readUInt32LE(offset);
    if (field !== value && !(descriptor && field === 0)) return null;
  }
  const nameStart = image.offset + LOCAL_HEADER_BYTES;
  const dataStart = nameStart + image.nameBytes.length + header.readUInt16LE(28);
  if (dataStart + image.packed > directoryStart) return null;
  const localName = await readRange(file, nameStart, image.nameBytes.length, signal);
  if (!localName?.equals(image.nameBytes)) return null;
  return readRange(file, dataStart, image.packed, signal);
}

function validDimensions(width, height) {
  return width > 0 && width <= MAX_DIMENSION &&
    height > 0 && height <= MAX_DIMENSION && width * height <= MAX_PIXELS;
}

function validPng(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      !validDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) ||
      bytes.readUInt32BE(29) !== crc32(bytes.subarray(12, 29))) return false;
  let hasData = false;
  for (let position = 33; position + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(position);
    const next = position + 12 + length;
    if (next > bytes.length) return false;
    const type = bytes.readUInt32BE(position + 4);
    if (type === 0x6163544c) return false; // acTL marks an animated PNG.
    if (type === 0x49444154 && length) hasData = true; // IDAT
    if (type === 0x49454e44) { // IEND
      return hasData && length === 0 && next === bytes.length && bytes.readUInt32BE(next - 4) === 0xae426082;
    }
    position = next;
  }
  return false;
}

function validJpeg(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  let position = 2;
  let components = 0;
  while (position < bytes.length && bytes[position++] === 0xff) {
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === 0xd9 || position + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(position);
    if (length < 2 || position + length > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (components || length < 8 ||
          !validDimensions(bytes.readUInt16BE(position + 5), bytes.readUInt16BE(position + 3))) return false;
      components = bytes[position + 7];
      if (components < 1 || components > 4 || length !== 8 + 3 * components) return false;
    }
    if (marker === 0xda) {
      const scanComponents = bytes[position + 2];
      return scanComponents > 0 && scanComponents <= components &&
        length === 6 + 2 * scanComponents && position + length < bytes.length - 2;
    }
    position += length;
  }
  return false;
}

/** Read only the ZIP directory and one bounded embedded preview. */
async function readEmbedded3mfImage(path, signal) {
  let file;
  try {
    signal?.throwIfAborted();
    file = await fs.open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const directory = await locateDirectory(file, stat.size, signal);
    if (!directory) return null;
    const central = await readRange(file, directory.start, directory.length, signal);
    if (!central) return null;
    const image = chooseImage(central, directory);
    if (!image) return null;
    const packed = await entryData(file, image, directory.start, signal);
    if (!packed) return null;
    const bytes = image.method === 0 ? packed : await inflate(packed, { maxOutputLength: image.unpacked });
    signal?.throwIfAborted();
    if (bytes.length !== image.unpacked || crc32(bytes) !== image.crc) return null;
    if (image.type === 'png') return validPng(bytes) ? { mime: 'image/png', bytes } : null;
    return validJpeg(bytes) ? { mime: 'image/jpeg', bytes } : null;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code) return null;
    throw error;
  } finally {
    await file?.close();
  }
}

module.exports = { readEmbedded3mfImage };
