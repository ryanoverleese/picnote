import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

function loadPuppeteer() {
  const origins = [
    path.join(import.meta.dirname, 'package.json'),
    '/tmp/picnote-test/package.json',
  ];
  for (const origin of origins) {
    try {
      return createRequire(origin)('puppeteer-core');
    } catch {
      // Try the next place puppeteer-core may be installed.
    }
  }
  throw new Error('Install puppeteer-core, then run: node --test --test-concurrency=1 tests/save-image.test.mjs');
}

const puppeteer = loadPuppeteer();

const root = path.resolve(import.meta.dirname, '..');
const fixtureDir = '/tmp/picnote-save-fixtures';
const shotDir = '/tmp/picnote-save-shots';
const photoPath = path.join(fixtureDir, 'photo.png');
const PHOTO_W = 180;
const PHOTO_H = 90;
const CAPTION = 'Test caption';

function png(width, height, r, g, b) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + body.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, 4 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpegSize(buf) {
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  throw new Error('JPEG size marker not found');
}

function startServer() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.normalize(path.join(root, rel));
    const inside = file === root || file.startsWith(root + path.sep);
    if (inside && !rel.startsWith('/.git') && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(root, '404.html')).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function preserved(page) {
  return page.evaluate((caption) => ({
    caption: document.querySelector('#captionInput').value,
    captionOpen: !document.querySelector('#captionSection').classList.contains('hidden'),
    previewOpen: !document.querySelector('#finalImageSection').classList.contains('hidden'),
    status: document.querySelector('#saveStatus').textContent,
    canvasWidth: document.querySelector('#liveCanvas').width,
    canvasHeight: document.querySelector('#liveCanvas').height,
  }), CAPTION);
}

function assertPreserved(state) {
  assert.equal(state.caption, CAPTION);
  assert.equal(state.captionOpen, true);
  assert.equal(state.previewOpen, true);
  assert.equal(state.status, 'Could not save the image.');
  assert.equal(state.canvasWidth, PHOTO_W);
  assert.equal(state.canvasHeight, PHOTO_H);
}

async function downloads(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('receipt-'));
}

async function saveAndWait(page, statusText) {
  const already = await page.$eval('#saveStatus', (el) => el.textContent);
  if (already === statusText) {
    throw new Error(`status is already ${JSON.stringify(statusText)}; this wait would match the previous attempt`);
  }
  await page.click('#liveCanvas', { button: 'right' });
  await page.waitForFunction(
    (expected) => document.querySelector('#saveStatus')?.textContent === expected,
    {},
    statusText,
  );
}

const { server, base } = await startServer();
fs.mkdirSync(fixtureDir, { recursive: true });
fs.mkdirSync(shotDir, { recursive: true });
fs.writeFileSync(photoPath, png(PHOTO_W, PHOTO_H, 180, 60, 60));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function preparedPage(downloadDir) {
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  await page.evaluateOnNewDocument(() => {
    window.__nativeToBlob = HTMLCanvasElement.prototype.toBlob;
    window.__nativeCreateObjectURL = URL.createObjectURL;
    window.__nativeImage = window.Image;
  });
  await page.goto(base + '/', { waitUntil: 'networkidle0' });
  await (await page.$('#fileInput')).uploadFile(photoPath);
  await page.waitForSelector('#captionSection:not(.hidden)');
  await page.type('#captionInput', CAPTION);
  await page.waitForFunction((w, h) => {
    const canvas = document.querySelector('#liveCanvas');
    return canvas && canvas.width === w && canvas.height === h;
  }, {}, PHOTO_W, PHOTO_H);
  return page;
}

test('drawing throw releases the save lock, keeps the photo, and a retry saves', async () => {
  const dir = '/tmp/picnote-save-dl/draw';
  const page = await preparedPage(dir);
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.fillText;
    let failed = false;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas && this.canvas.id !== 'liveCanvas' && !failed) {
        failed = true;
        throw new Error('draw failed');
      }
      return original.apply(this, args);
    };
  });

  await saveAndWait(page, 'Could not save the image.');
  assert.deepEqual(await downloads(dir), []);
  assertPreserved(await preserved(page));
  await page.screenshot({ path: path.join(shotDir, 'draw-failure.png') });

  await saveAndWait(page, '');
  await page.waitForFunction(() => document.querySelector('#captionSection').classList.contains('hidden'));
  const files = await downloads(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^receipt-\d+\.jpg$/);
  await page.close();
});

test('encoder throw releases the save lock and the retry keeps jpeg output', async () => {
  const dir = '/tmp/picnote-save-dl/encoder';
  const page = await preparedPage(dir);
  await page.evaluate(() => {
    window.__encoderAttempts = 0;
    HTMLCanvasElement.prototype.toBlob = function () {
      window.__encoderAttempts += 1;
      throw new Error('encoder failed');
    };
  });

  await saveAndWait(page, 'Could not save the image.');
  assert.equal(await page.evaluate(() => window.__encoderAttempts), 1);
  assert.deepEqual(await downloads(dir), []);
  assertPreserved(await preserved(page));

  await page.click('#liveCanvas', { button: 'right' });
  await page.waitForFunction(() => window.__encoderAttempts === 2);
  assert.deepEqual(await downloads(dir), []);
  assertPreserved(await preserved(page));
  await page.screenshot({ path: path.join(shotDir, 'encoder-failure.png') });

  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      window.__saveMeta = { type, quality, width: this.width, height: this.height };
      return window.__nativeToBlob.call(this, (blob) => {
        window.__blobType = blob && blob.type;
        callback(blob);
      }, type, quality);
    };
  });
  await saveAndWait(page, '');
  await page.waitForFunction(() => document.querySelector('#captionSection').classList.contains('hidden'));
  const files = await downloads(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^receipt-\d+\.jpg$/);
  const bytes = fs.readFileSync(path.join(dir, files[0]));
  const size = jpegSize(bytes);
  const meta = await page.evaluate(() => ({ ...window.__saveMeta, blobType: window.__blobType }));
  assert.equal(meta.type, 'image/jpeg');
  assert.equal(meta.quality, 0.95);
  assert.equal(meta.width, PHOTO_W);
  assert.equal(meta.height, PHOTO_H);
  assert.equal(meta.blobType, 'image/jpeg');
  assert.deepEqual(size, { width: PHOTO_W, height: PHOTO_H });
  await page.screenshot({ path: path.join(shotDir, 'retry-success.png') });
  await page.close();
});

test('null blob preserves the photo and caption, then a retry saves', async () => {
  const dir = '/tmp/picnote-save-dl/null';
  const page = await preparedPage(dir);
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      queueMicrotask(() => callback(null));
    };
  });
  await saveAndWait(page, 'Could not save the image.');
  assert.deepEqual(await downloads(dir), []);
  assertPreserved(await preserved(page));
  await page.screenshot({ path: path.join(shotDir, 'null-blob.png') });

  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = window.__nativeToBlob;
  });
  await saveAndWait(page, '');
  await page.waitForFunction(() => document.querySelector('#captionSection').classList.contains('hidden'));
  const files = await downloads(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^receipt-\d+\.jpg$/);
  const size = jpegSize(fs.readFileSync(path.join(dir, files[0])));
  assert.deepEqual(size, { width: PHOTO_W, height: PHOTO_H });
  await page.close();
});

test('a synchronous null blob and a throw inside the encoder callback can be retried', async () => {
  const dir = '/tmp/picnote-save-dl/callback';
  const page = await preparedPage(dir);
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      callback(null);
    };
  });
  await saveAndWait(page, 'Could not save the image.');
  assertPreserved(await preserved(page));

  await page.evaluate(() => {
    window.__callbackAttempts = 0;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      window.__nativeToBlob.call(this, (blob) => {
        window.__callbackAttempts += 1;
        callback(blob);
      }, type, quality);
    };
    URL.createObjectURL = () => {
      throw new Error('url failed');
    };
  });
  await page.click('#liveCanvas', { button: 'right' });
  await page.waitForFunction(() => window.__callbackAttempts === 1);
  assert.deepEqual(await downloads(dir), []);
  assertPreserved(await preserved(page));

  await page.evaluate(() => {
    URL.createObjectURL = window.__nativeCreateObjectURL;
    HTMLCanvasElement.prototype.toBlob = window.__nativeToBlob;
  });
  await saveAndWait(page, '');
  await page.waitForFunction(() => document.querySelector('#captionSection').classList.contains('hidden'));
  const files = await downloads(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^receipt-\d+\.jpg$/);
  await page.close();
});

test('an image that fails to open during save does not stick the lock', async () => {
  const dir = '/tmp/picnote-save-dl/decode';
  const page = await preparedPage(dir);
  await page.evaluate(() => {
    const Native = window.__nativeImage;
    window.Image = class extends Native {
      set src(_value) {
        queueMicrotask(() => {
          if (typeof this.onerror === 'function') this.onerror(new Event('error'));
        });
      }
    };
  });
  await saveAndWait(page, 'Could not save the image.');
  assertPreserved(await preserved(page));

  await page.evaluate(() => {
    window.Image = window.__nativeImage;
  });
  await saveAndWait(page, '');
  await page.waitForFunction(() => document.querySelector('#captionSection').classList.contains('hidden'));
  const files = await downloads(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^receipt-\d+\.jpg$/);
  await page.close();
});

test.after(async () => {
  await browser.close();
  server.close();
});
