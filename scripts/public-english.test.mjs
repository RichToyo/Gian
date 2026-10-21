import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { isPublicPath } from './delivery-certificate.mjs';
import { loadMediaReviews, mediaReviewPath, scanPublicEntries } from './public-english.mjs';

function scan(entries, reviews = new Map()) {
  return scanPublicEntries(entries, reviews);
}

function text(name, value) {
  return scan([{ path: name, bytes: Buffer.from(value) }]);
}

function utf16(units, endian) {
  const body = Buffer.alloc(units.length * 2);
  units.forEach((unit, index) => {
    if (endian === 'le') {
      body[index * 2] = unit & 0xff;
      body[index * 2 + 1] = unit >> 8;
    } else {
      body[index * 2] = unit >> 8;
      body[index * 2 + 1] = unit & 0xff;
    }
  });
  const bom = endian === 'le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
  return Buffer.concat([bom, body]);
}

test('strict UTF-16 rejects odd lengths, lone surrogates, and a UTF-32 BOM', () => {
  const han = String.fromCodePoint(0x4e2d);
  const supplementary = String.fromCodePoint(0x20000);
  const leHan = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`A${supplementary}B`, 'utf16le')]);
  const leResult = scan([{ path: 'note.txt', bytes: leHan }]);
  assert.equal(leResult.violations.some(item => item.kind === 'han-text' && item.encoding === 'utf-16le' && item.detail.includes('index 1')), true);
  const mixed = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`A${String.fromCodePoint(0x1f600)}${han}`, 'utf16le'),
  ]);
  assert.equal(scan([{ path: 'mixed.txt', bytes: mixed }]).violations.some(item => item.kind === 'han-text' && item.detail.includes('index 3')), true);

  const beHan = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(han, 'utf16le').swap16()]);
  assert.equal(scan([{ path: 'be.txt', bytes: beHan }]).violations[0].encoding, 'utf-16be');
  assert.equal(text('ascii.txt', utf16([0x0041, 0x0042], 'be')).ok, true);

  for (const bytes of [
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x41])]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00])]),
    utf16([0xd840], 'le'),
    utf16([0xdc00], 'le'),
    utf16([0xd840, 0x0041], 'be'),
    Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00]),
  ]) {
    assert.equal(scan([{ path: 'bad.txt', bytes }]).violations[0].kind, 'unreviewed-binary');
  }
});

test('encoded Han includes surrogate pairs and uppercase numeric entities', () => {
  const pair = `${'\\u'}D840${'\\u'}DC00`;
  const braced = `${'\\u'}{20000}`;
  const upper = `&#X${'4E2D'};`;
  const decimal = `&#${'131072'};`;
  for (const value of [pair, braced, upper, decimal]) {
    const result = text('hidden.txt', value);
    assert.equal(result.violations[0].kind, 'han-escape', value);
  }
  assert.equal(text('split.txt', `${'\\u'}D840 ${'\\u'}DC00`).ok, true);
  assert.equal(text('lone.txt', `${'\\u'}D840`).ok, true);
  assert.equal(text('letter.txt', `${'\\u'}0041`).ok, true);
  assert.equal(text('property.txt', `${'\\p'}{Script=Han}`).ok, true);
  assert.equal(text('computed.txt', 'String.fromCodePoint(0x4e2d)').ok, true);
  const encoded = Buffer.from(String.fromCodePoint(0x4e2d), 'utf8').toString('base64');
  assert.equal(text('encoded.txt', encoded).ok, true);
  assert.equal(text('prose.txt', String.fromCodePoint(0x4e2d)).violations[0].kind, 'han-text');
});

test('media review is an exact path and digest, never an extension or SVG waiver', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const digest = createHash('sha256').update(png).digest('hex');
  const reviews = new Map([['brand/mark.png', { path: 'brand/mark.png', sha256: digest, kind: 'png' }]]);
  assert.equal(scan([{ path: 'brand/mark.png', bytes: png }], reviews).ok, true);
  assert.equal(scan([{ path: 'brand/other.png', bytes: png }], reviews).violations[0].kind, 'unreviewed-media');
  assert.equal(scan([{ path: 'brand/mark.png', bytes: Buffer.from('nope') }], reviews).violations[0].kind, 'media-hash-mismatch');
  const svg = Buffer.from(`<svg>${String.fromCodePoint(0x4e2d)}</svg>`);
  assert.equal(scan([{ path: 'brand/mark.svg', bytes: svg }], reviews).violations[0].kind, 'han-text');
  assert.throws(() => loadMediaReviews(JSON.stringify({ schema: 1, extensions: ['.png'], entries: [{ path: 'a.png', sha256: digest }] })), /extension or glob/);
  assert.throws(() => loadMediaReviews(JSON.stringify({ schema: 1, entries: [{ path: 'icon.svg', sha256: digest }] })), /text scan/);
  assert.throws(() => loadMediaReviews(JSON.stringify({ schema: 1, entries: [{ path: 'a*.png', sha256: digest }] })), /relative file/);
});

test('reviewed bytes match the manifest and private snapshots stay out', () => {
  const reviews = loadMediaReviews(readFileSync(mediaReviewPath(), 'utf8'));
  assert.equal(reviews.size, 31);
  for (const review of reviews.values()) {
    const bytes = readFileSync(new URL(`../${review.path}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), review.sha256, review.path);
    assert.equal(isPublicPath(review.path), true, review.path);
    assert.equal(review.path.endsWith('.svg'), false);
  }
  const snapshot = 'e2e/specs/10-ui-regression.spec.ts-snapshots/gian-dev-badge-chromium.png';
  assert.equal(reviews.has(snapshot), false);
  assert.equal(isPublicPath(snapshot), false);
  assert.equal(isPublicPath('.github/assets/readme/gian-icon.svg'), true);
  assert.equal(reviews.has('.github/assets/readme/gian-icon.svg'), false);
  const svg = readFileSync(new URL('../.github/assets/readme/gian-icon.svg', import.meta.url));
  assert.equal(scan([{ path: '.github/assets/readme/gian-icon.svg', bytes: svg }], reviews).ok, true);
});

test('publication workflows scan the exact revision before upload or deploy', () => {
  const root = new URL('..', import.meta.url);
  const read = path => readFileSync(new URL(path, root), 'utf8');
  const privateCheckout = existsSync(new URL('AGENTS.md', root));
  const scan = 'node scripts/check-public-english.mjs --ref';
  const publications = [
    ['.github/workflows/release.yml', ['gh release create']],
    ['.github/workflows/release-promote.yml', ['gh release edit']],
    ['.github/workflows/proxy-protocol-release.yml', ['gh release create']],
    ['.github/workflows/remote-protocol-release.yml', ['gh release create']],
    ['.github/workflows/proxy-release.yml', ['gh release create', 'gh release edit']],
    ['.github/workflows/release-owner-065.yml', ['gh release edit']],
    ['delivery/proxies/.github/workflows/release.yml', ['pnpm run publish']],
    ['delivery/proxies/.github/workflows/qualify.yml', ['actions/upload-artifact@v4']],
    ['delivery/proxies/.github/workflows/catalog.yml', ['release-product.mjs catalog']],
    ['delivery/proxies/.github/workflows/catalog-docs.yml', ['release-product.mjs catalog']],
    ['delivery/remote/.github/workflows/release.yml', ['docker push', 'gh release create']],
    ['delivery/remote/.github/workflows/deploy.yml', ['scripts/deploy-ssh.mjs']],
  ];
  for (const [path, markers] of publications) {
    if (!privateCheckout && !isPublicPath(path)) {
      assert.equal(existsSync(new URL(path, root)), false, path);
      continue;
    }
    const workflow = read(path);
    const scanned = workflow.indexOf(scan);
    assert.ok(scanned >= 0, path);
    for (const marker of markers) {
      const action = workflow.indexOf(marker);
      assert.ok(action > scanned, `${path} scans before ${marker}`);
    }
  }
  for (const path of ['.github/workflows/proxy-protocol-release.yml', '.github/workflows/remote-protocol-release.yml']) {
    const workflow = read(path);
    const upload = workflow.indexOf('actions/upload-artifact@v4');
    const release = workflow.indexOf('gh release create');
    const scans = [...workflow.matchAll(/node scripts\/check-public-english\.mjs --ref/g)].map(match => match.index);
    assert.ok(scans.some(index => index < upload), path);
    assert.ok(scans.some(index => index > upload && index < release), path);
  }
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/dev-package.yml',
    '.github/workflows/nightly-e2e.yml',
    '.github/workflows/giandev-acceptance.yml',
    '.github/workflows/security-audit.yml',
    '.github/workflows/remote.yml',
  ]) {
    assert.equal(isPublicPath(path), false, path);
    if (privateCheckout) assert.equal(read(path).includes('check-public-english'), false, path);
    else assert.equal(existsSync(new URL(path, root)), false, path);
  }
  if (privateCheckout) {
    const historical = read('.github/workflows/release-owner-065.yml');
    assert.match(historical, /run\.repository\.full_name, 'RichLogic\/Gian'/);
  }
  assert.equal(isPublicPath('.github/workflows/release-owner-065.yml'), false);
  assert.equal(isPublicPath('.github/workflows/public-english.yml'), true);
  assert.match(read('.github/workflows/proxy-release.yml'), /github\.repository == 'RichToyo\/Gian'/);
  const english = read('.github/workflows/public-english.yml');
  assert.equal(english, read('delivery/proxies/.github/workflows/public-english.yml'));
  assert.equal(english, read('delivery/remote/.github/workflows/public-english.yml'));
});
