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
const repository = 'RichToyo/Gian-Proxies';
export const proxyReleaseNotes = {
  claude: {
    id: 'claude', directory: 'claude',
    text: 'Update the managed Claude Code Runtime to official 2.1.310 (GitHub latest v2.1.310 and npm latest; the vendor /stable pointer still reads 2.1.308, recorded as a lagging rolling pointer, not prerelease evidence). Match the official manifest SHA-256 and size and verify the nine selected startup flags. Retain MCP SDK 1.32.0 and bounded HTTP input. The 2.1.310 changelog review found no documented headless spawn/wire compatibility changes. Exact artifacts pass hosted qualification; authenticated Provider turns and App/Desktop acceptance are not claimed.',
  },
  codex: {
    id: 'codex', directory: 'codex',
    text: 'Republish the Codex Proxy at 0.3.9 with the shared security repair set: Proxy Protocol SDK 1.0.3 (zod exactly 4.6.6, wire unchanged), body-parser 2.4.0 and undici 8.12.2. The verified Codex CLI Runtime stays 0.164.0. Exact artifacts pass hosted qualification; real Provider turns and App/Desktop acceptance are not claimed.',
  },
  dsh: {
    id: 'ai.deepseek.harness', directory: 'ai.deepseek.harness',
    text: 'Republish the DeepSeek Harness Proxy at 0.3.8 with the shared security repair set: Proxy Protocol SDK 1.0.3 (zod exactly 4.6.6, wire unchanged) and a dependency-repaired managed Runtime whose lock resolves a single zod 4.6.7 and undici 8.12.2 (CLI stays 0.2.1-rc.2; the repaired bytes live under the new 0.3.8 tag, never overwriting 0.3.7). Bundled Bridge remains 0.1.7. Exact artifacts pass hosted qualification; real Provider turns are not claimed.',
  },
  kimi: {
    id: 'kimi', directory: 'kimi',
    text: 'Update the managed Kimi Code Runtime to official 2.3.2, matching the GitHub release asset digest. The 2.3.1-to-2.3.2 diff touches no kap-server file, so the transport/API is unchanged; shared agent-core tool-driven swarm entry is disabled until the user enables swarm mode (swarmService.enter("tool") throws, AgentSwarm resolve/execute return isError when inactive, transcript folding ignores tool-triggered activation), which can affect web-runtime behavior - this Proxy declares and enables no swarm policy and its generic isError/replay handling stays compatible. A bounded no-Provider native probe confirms 2.3.2 reports 2.3.2, serves the same 112 REST paths and the production token layout (raw evidence preserved). Exact artifacts pass hosted qualification; real Provider turns are not claimed.',
  },
  grok: {
    id: 'grok', directory: 'grok',
    text: 'Update the managed Grok CLI to official stable 1.0.70 (x.ai/cli stable, the official GCS mirror and npm latest agree; downloaded bytes are byte-identical across both sources). Verify the spawn flags and ACP initialize contract on the new binary (agentVersion 1.0.70, grokShell; session creation stays auth-gated, raw evidence preserved). Per-version 1.0.68-1.0.70 release notes remain NOT_OBSERVED in the accessible official changelog. Exact artifacts pass hosted qualification; native authenticated approval behavior remains unverified.',
  },
  antigravity: {
    id: 'io.gian.antigravity', directory: 'io.gian.antigravity',
    text: 'Update the upstream Antigravity ACP Runtime to 1.4.3, the current ACP registry version. The official dl.google.com ZIP passes strict production pair validation with pinned bytes; a bounded no-credential ACP initialize reports antigravity-acp 1.4.3 with a capability shape identical to 1.4.1 (raw old/new evidence retained). Exact artifacts pass hosted qualification; real Provider turns and App/Desktop acceptance are not claimed.',
  },
  zcode: {
    id: 'com.zhipu.zcode', directory: 'com.zhipu.zcode',
    text: 'Publish an English-only ZCode Proxy from RichToyo, removing the remaining first-party localized fork comment. Retain reviewed App-source 3.16.2 at commit 3c5b227 and CLI 0.17.0 without altering original upstream source or notices. Exact artifacts pass hosted qualification; real Provider turns and App/Desktop acceptance are not claimed.',
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
  assert.equal(certificate.repository, repository);
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
    assert.equal(releaseUrl, `https://github.com/${repository}/releases/tag/${record.tag}`);
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
          ? [{ id: '@gian/dsh-bridge', version: '0.1.7', basis: 'bundled-package-source' }]
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
