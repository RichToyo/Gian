import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = join(root, 'catalog/proxy-information/evidence');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const repository = 'RichLogic/Gian-Proxies';
export const proxyReleaseNotes = {
  claude: {
    id: 'claude', directory: 'claude',
    text: 'Update the managed Claude Code Runtime to 2.1.302 (promoted to /latest, npm latest and GitHub latest on 2026-10-16; SHA-256 and size verified against the official manifest). Upstream 2.1.302 has no wire-protocol or spawn-surface changes; every flag the adapter spawns or parses was re-verified on the new binary. The wire protocol range is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release.',
  },
  codex: {
    id: 'codex', directory: 'codex',
    text: 'Update the managed Codex CLI to 0.163.0 (first stable of the 0.163 line, published 2026-10-15; matching the official rust-v0.163.0 GitHub asset digest). Exact old/new app-server schema comparison shows additive-only changes across every Proxy-used protocol surface (optional fields, new read-state notifications), a byte-identical ServerRequest, and no removed or changed method the Proxy calls (unrelated realtime voice enums also changed; the Proxy does not use them); no-credential initialize handshakes are identical on 0.162.1 and 0.163.0. The wire contract is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release.',
  },
  dsh: {
    id: 'ai.deepseek.harness', directory: 'ai.deepseek.harness',
    // Next publish copy. changelog.md's top snapshot stays the published
    // Proxy 0.3.3 / Runtime 0.1.5-rc.3 projection until this capture runs.
    text: 'Support DeepSeek Harness 0.2.0-rc.2: session logs move to V4, a saved model that is no longer advertised falls back to the current default with a prompt to reselect, and Side Chat plus native session fork are now available. Bundled Bridge is 0.1.6. Real model turns were not run for this release.',
  },
  kimi: {
    id: 'kimi', directory: 'kimi',
    text: 'Update the Kimi Code Runtime to 2.2.0 (matching the official @moonshot-ai/kimi-code@2.2.0 GitHub asset digest). The published server-api reference diff from 2.1.1 to 2.2.0 is purely additive (Remote Control endpoints, optional fields), and a live 2.2.0 /openapi.json + /asyncapi.json probe confirmed every REST route and WebSocket message type this Proxy uses. The adapter and the wire protocol range are unchanged. Artifacts pass hosted qualification; real model turns were not run for this release.',
  },
  grok: {
    id: 'grok', directory: 'grok',
    text: 'Update the managed Grok CLI to 1.0.62 (promoted to stable on x.ai/cli, the official GCS mirror and npm @xai-official/grok latest; bytes identical from x.ai and GCS). The spawn flags and ACP initialize contract are verified on the new binary (agentVersion 1.0.62, grokShell, unchanged capability shape; raw handshake evidence preserved); per-version notes for 1.0.53–1.0.62 are NOT_OBSERVED in the accessible official changelog, whose latest entry remains 1.0.52 — recorded honestly rather than blocking the promoted stable channel. Known limitation unchanged: native approval cards under auto/always_approve snapshots remain unverified (an authenticated session is required). The wire protocol range is unchanged. Artifacts pass hosted qualification; real model turns were not run for this release.',
  },
  zcode: {
    id: 'com.zhipu.zcode', directory: 'com.zhipu.zcode',
    text: 'Update the managed Runtime to reviewed ZCode v3.15.1 source aac4755 (upstream CLI still reports 0.16.9), retaining standalone authentication and model catalog integration. Fix native MCP forms: free-text inputs, optional fields, indexed answers for repeated questions, and exact string preservation. Artifacts pass hosted qualification; real model turns were not run for this release.',
  },
};

function releaseEvidence(release) {
  return {
    tag: release.tag_name,
    date: release.published_at,
    url: release.html_url,
    body: release.body,
    assets: release.assets.map(asset => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      digest: asset.digest,
    })),
  };
}

function capture(sequence, certificatePath, baseIndexPath, releaseDir, providers) {
  assert.ok(Number.isSafeInteger(sequence) && sequence > 0);
  assert.ok(providers.length > 0 && new Set(providers).size === providers.length);
  const certificateBytes = readFileSync(certificatePath);
  const certificate = JSON.parse(certificateBytes);
  const ownerDirect = certificate.releaseMode === 'owner-authorized-no-tests';
  assert.equal(certificate.status, ownerDirect ? 'NOT_RUN' : 'PASS');
  if (ownerDirect) {
    assert.deepEqual(providers, ['claude']);
    assert.equal(certificate.proxies.length, 1);
    assert.ok(['0.3.4', '0.3.5'].includes(certificate.proxies[0].version));
  }
  const certificateDigest = sha256(certificateBytes);
  const base = json(baseIndexPath);
  assert.equal(base.sourceId, 'gian-official');
  assert.ok(base.sequence < sequence);
  const releaseRecord = json(join(evidenceRoot, 'releases.json'));
  const manifestRecords = json(join(evidenceRoot, 'manifests.json'));
  const selected = new Map();

  for (const provider of providers) {
    const note = proxyReleaseNotes[provider];
    assert.ok(note, `Unknown provider ${provider}`);
    const record = certificate.proxies.find(item => item.provider === provider);
    assert.ok(record && record.pluginId === note.id);
    const release = json(join(releaseDir, `${record.tag}.release.json`));
    assert.equal(release.tag_name, record.tag);
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, false);
    const releaseUrl = release.html_url;
    const asset = name => {
      const found = release.assets.find(item => item.name === name);
      assert.ok(found && found.digest?.startsWith('sha256:'));
      return found;
    };
    const certificateAsset = asset('certificate.json');
    assert.equal(certificateAsset.digest, `sha256:${certificateDigest}`);
    const archiveAsset = asset(record.archive);
    const qualifiedArchive = certificate.assets.find(item => item.name === record.archive);
    assert.equal(archiveAsset.digest, `sha256:${qualifiedArchive?.sha256}`);
    assert.equal(archiveAsset.size, qualifiedArchive.size);
    const manifestAsset = asset(`${record.archive}.manifest.json`);
    const manifestBytes = readFileSync(join(releaseDir, manifestAsset.name));
    assert.equal(manifestAsset.digest, `sha256:${sha256(manifestBytes)}`);
    const manifest = JSON.parse(manifestBytes);
    assert.deepEqual(manifest, record.manifest);
    if (record.publishRuntime) {
      const runtimeAsset = asset(record.runtimeAsset);
      assert.equal(runtimeAsset.digest, `sha256:${record.runtime.asset.sha256}`);
      assert.equal(runtimeAsset.size, record.runtime.asset.size);
    }

    assert.ok(!releaseRecord.releases.some(item => item.url === releaseUrl));
    releaseRecord.releases.push(releaseEvidence(release));
    assert.ok(!manifestRecords.some(item => item.url === releaseUrl));
    manifestRecords.push({
      tag: record.tag,
      url: releaseUrl,
      manifestUrl: manifestAsset.browser_download_url,
      digest: manifestAsset.digest,
      assetDigestVerified: true,
      schemaVersion: manifest.schemaVersion,
      pluginId: manifest.id,
      pluginVersion: manifest.pluginVersion,
      protocol: manifest.protocol,
      runtime: manifest.runtime,
      process: manifest.process,
    });

    const historyPath = join(root, 'catalog/proxy-information', note.directory, 'changelog.json');
    const history = json(historyPath);
    assert.ok(!history.entries.some(item => item.version === record.version));
    history.currentVersion = record.version;
    history.entries.unshift({
      version: record.version,
      firstPublishedAt: release.published_at,
      evidenceCoverage: 'detailed',
      distributions: [{
        repository,
        tag: record.tag,
        publishedAt: release.published_at,
        releaseUrl,
        manifestUrl: manifestAsset.browser_download_url,
        manifestSha256: sha256(manifestBytes),
        archive: {
          url: archiveAsset.browser_download_url,
          sha256: qualifiedArchive.sha256,
          size: qualifiedArchive.size,
        },
        runtimeDeclaration: {
          id: manifest.runtime.id,
          versions: manifest.runtime.verifiedVersions,
          basis: 'verified-declaration',
        },
        companionDeclarations: provider === 'dsh'
          ? [{ id: '@gian/dsh-bridge', version: '0.1.6', basis: 'bundled-package-source' }]
          : [],
        protocolRange: manifest.protocol.range,
        manifestSchema: manifest.schemaVersion,
        processScope: manifest.process.scope,
      }],
      changes: [{
        category: 'changed',
        text: note.text,
        evidence: [releaseUrl, `https://github.com/${repository}/blob/${record.tag}/${provider === 'claude'
          ? 'packages/proxies/cc-proxy/src/protocol/v2-adapter.ts'
          : `packages/proxies/${provider}-proxy/README.md`}`],
      }],
      unknowns: ownerDirect ? ['All tests, Runtime probes and archive self-tests are NOT_RUN by Owner instruction.'] : [],
    });
    write(historyPath, history);
    selected.set(note.id, record);
  }

  const current = {
    catalog: `https://github.com/${repository}/releases/tag/catalog-v1.${sequence}.0`,
    sequence,
    sourceId: base.sourceId,
    plugins: base.plugins.map(plugin => {
      const pluginId = plugin.pluginId ?? plugin.id;
      const record = selected.get(pluginId);
      const stable = plugin.stable ?? plugin;
      return {
        id: pluginId,
        displayName: plugin.displayName,
        version: record?.version ?? stable.version ?? stable.pluginVersion,
        protocolRange: record?.manifest.protocol.range ?? stable.protocolRange,
        processScope: record?.manifest.process.scope ?? stable.processScope,
        combination: record ? {
          certificate: { id: certificate.certificateId, sha256: certificateDigest },
          companions: [],
          generationId: `${record.provider}-${record.version}-runtime-${record.runtime.version}`,
          runtime: record.runtime,
        } : stable.combination,
      };
    }),
  };
  assert.equal(current.plugins.length, base.plugins.length);
  assert.equal(selected.size, providers.length);
  releaseRecord.capturedAt = new Date().toISOString();
  releaseRecord.selection = 'Public stable Proxy Releases represented by the retained version histories; withdrawn or prerelease identities are excluded.';
  write(join(evidenceRoot, 'releases.json'), releaseRecord);
  write(join(evidenceRoot, 'manifests.json'), manifestRecords);
  write(join(evidenceRoot, 'current-combinations.json'), current);
  console.log(`Captured ${providers.join(', ')} for Catalog ${sequence}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sequenceText, certificatePath, baseIndexPath, releaseDir, ...providers] = process.argv.slice(2);
  if (!sequenceText || !certificatePath || !baseIndexPath || !releaseDir) {
    throw new Error('Usage: capture-proxy-release-evidence <sequence> <certificate> <base-index> <release-dir> <provider...>');
  }
  capture(Number(sequenceText), certificatePath, baseIndexPath, releaseDir, providers);
}
