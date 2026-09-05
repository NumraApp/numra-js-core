/* ═══════════════════════════════════════════════════════════════════════════
   Conformance against the API contract
   ───────────────────────────────────────────────────────────────────────────
   Every Numra client is written against packages/shared/openapi.yaml. A client
   that has drifted from it compiles, passes its own unit tests — which assert
   against a mock this same repo wrote — and then disagrees with the live API
   about what a 429 means. Unit tests cannot catch that, because both sides of
   them are ours.

   This script is the release gate for that. It is deliberately unable to pass
   by default: with no contract vendored there is nothing to compare against,
   and a step called "conformance" that goes green having compared nothing is
   worse than no step at all — it manufactures the exact assurance it was added
   to provide. So it fails, and says which of its checks ran and which did not.

   To make it pass, vendor the spec (see CONTRIBUTING.md for the commit this
   SDK was verified against) at one of the paths in CONTRACT_PATHS, or point
   NUMRA_OPENAPI at it.

   Runs in both the npm repos and the Composer ones, so it uses dynamic
   import() and no top-level import/export: a .js file is ESM in a repo whose
   package.json says "type": "module" and CJS in a repo with no package.json at
   all, and only this form parses as both. No dependencies — a release gate
   that installs things can be broken by something else's bad publish.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const CONTRACT_PATHS = [
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'contract/openapi.yaml',
  'contract/openapi.yml',
  'contract/openapi.json',
  'scripts/openapi.yaml',
  'scripts/openapi.json',
];

async function main() {
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;

  const root = process.cwd();
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(root, rel));

  const ran = [];        // checks that actually compared two things
  const skipped = [];    // checks with nothing to compare, and why
  const failures = [];

  if (!exists('package.json') && !exists('composer.json')) {
    fail('Run this from the repository root — neither package.json nor composer.json is in ' + root);
  }

  /* ── 1. The version this repo states, in every place it states it ───────
     The release workflow checks the git tag against one of these. Nothing
     checks them against each other, so a bumped package.json with an
     unbumped VERSION constant ships a client that reports the wrong version
     in every User-Agent — which is what the API's own drift telemetry keys
     off. */
  const declared = [];

  if (exists('package.json')) {
    const pkg = JSON.parse(read('package.json'));
    if (pkg.version) declared.push({ where: 'package.json', version: pkg.version });
  }

  for (const rel of sourceFiles(fs, path, root)) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    // `export const VERSION = '1.2.3'` (JS) and `const VERSION = '1.2.3';` (PHP).
    const m = src.match(/\bVERSION\s*=\s*['"]([0-9]+\.[0-9]+\.[0-9]+[^'"]*)['"]/);
    if (m) declared.push({ where: rel, version: m[1] });
  }

  if (declared.length > 1) {
    const distinct = [...new Set(declared.map((d) => d.version))];
    if (distinct.length > 1) {
      failures.push(
        'The repo states more than one version:\n' +
          declared.map((d) => `    ${d.version}  (${d.where})`).join('\n') +
          '\n  Every request puts the constant in its User-Agent and the portal manifest is\n' +
          '  stamped from package.json. They cannot disagree.'
      );
    } else {
      ran.push(`version agreement across ${declared.length} declarations (${declared[0].version})`);
    }
  } else if (declared.length === 1) {
    skipped.push(`version agreement — only one declaration found (${declared[0].where})`);
  } else {
    failures.push('No version could be found in package.json or in src/. There is nothing to release.');
  }

  /* ── 2. The contract itself ─────────────────────────────────────────── */
  const contractRel = process.env.NUMRA_OPENAPI || CONTRACT_PATHS.find(exists);

  if (!contractRel || !exists(contractRel)) {
    report(ran, skipped);
    fail(
      'No API contract is vendored in this repo, so conformance was NOT checked.\n' +
        '\n' +
        '  What this run did verify: ' + (ran.length ? ran.join('; ') : 'nothing') + '\n' +
        '  What it did NOT verify:   that this client agrees with the API it claims\n' +
        '                            to speak — the endpoints it calls, and the error\n' +
        '                            codes it maps.\n' +
        '\n' +
        '  Vendor packages/shared/openapi.yaml at one of:\n' +
        CONTRACT_PATHS.map((p) => '    ' + p).join('\n') + '\n' +
        '  or set NUMRA_OPENAPI to its path. Pin the commit in CONTRIBUTING.md so the\n' +
        '  next person can tell which version of the API this was true against.'
    );
  }

  const contractSrc = read(contractRel);
  const contract = contractRel.endsWith('.json')
    ? JSON.parse(contractSrc)
    : {
        paths: yamlPathKeys(contractSrc),
        info: { version: yamlInfoVersion(contractSrc) },
        'x-numra-sdk-versions': yamlStringMap(contractSrc, 'x-numra-sdk-versions'),
      };

  const contractPaths = Object.keys(contract.paths || {});
  if (contractPaths.length === 0) {
    failures.push(`${contractRel} declares no paths. Either it is not an OpenAPI document or it is truncated.`);
  }

  /* ── 3. Every endpoint this client calls must exist in the contract ──── */
  const called = new Set();
  for (const rel of sourceFiles(fs, path, root)) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of src.matchAll(/['"](\/v[0-9]+\/[A-Za-z0-9/_-]+)['"]/g)) called.add(m[1]);
  }

  if (called.size === 0) {
    /* True of every wrapper package: @numra/express and friends reach the API
       only through @numra/core, so there is no path here to check. Saying so
       is the point — silence would read as a pass. */
    skipped.push('endpoint conformance — this repo\'s source requests no API path of its own');
  } else {
    const missing = [...called].filter((p) => !contractPaths.includes(p));
    if (missing.length) {
      failures.push(
        'This client calls endpoints the contract does not declare:\n' +
          missing.map((p) => '    ' + p).join('\n') +
          `\n  Contract: ${contractRel} (info.version ${contract.info?.version ?? 'unstated'})`
      );
    }
    ran.push(`${called.size} endpoint(s) against ${contractRel} (info.version ${contract.info?.version ?? 'unstated'})`);
  }

  /* ── 4. The SDK-version range the contract itself declares, if any ─────
     Optional because it is the API's to declare, not ours to assume. If the
     spec carries x-numra-sdk-versions, a client outside the range is drift the
     API already knows about. */
  const range = contract['x-numra-sdk-versions'];
  const name = exists('package.json') ? JSON.parse(read('package.json')).name : JSON.parse(read('composer.json')).name;
  if (range && typeof range === 'object' && range[name]) {
    const want = String(range[name]);
    const have = declared[0]?.version ?? '';
    if (!satisfiesMajor(have, want)) {
      failures.push(`The contract declares ${name} ${want}; this repo is ${have}.`);
    } else {
      ran.push(`declared SDK range for ${name} (${want})`);
    }
  } else {
    skipped.push(`SDK-version range — ${contractRel} declares no x-numra-sdk-versions entry for ${name}`);
  }

  report(ran, skipped);
  if (failures.length) fail(failures.join('\n\n  '));
  console.log('Conformance OK.');
}

/* Source files worth scanning: the published code, not the tests. A test may
   legitimately name an endpoint that does not exist, to prove the client
   handles a 404. */
function sourceFiles(fs, path, root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(rel, e.name);
      if (e.isDirectory()) walk(next);
      else if (/\.(js|mjs|cjs|ts|php)$/.test(e.name)) out.push(next);
    }
  };
  walk('src');
  return out;
}

/* Enough YAML for two questions: which keys are under `paths:`, and what is
   `info.version`. A real parser would be a dependency, and a dependency in a
   release gate can be broken by somebody else's bad publish. If the spec ever
   uses anchors or flow mappings for its path keys, switch the vendored copy to
   openapi.json — the JSON branch above parses properly. */
function yamlPathKeys(src) {
  const out = {};
  let inPaths = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^\S/.test(line)) break;          // next top-level key
    if (!inPaths) continue;
    const m = line.match(/^\s{2}(['"]?)(\/[^'":]*)\1\s*:\s*$/);
    if (m) out[m[2]] = {};
  }
  return out;
}

/* One flat `key: "value"` block under a named top-level key. Same reason as
   yamlPathKeys for not reaching for a parser — and the same escape hatch: if
   the block ever grows past flat strings, vendor openapi.json instead. */
function yamlStringMap(src, topKey) {
  const out = {};
  let inside = false;
  for (const line of src.split(/\r?\n/)) {
    if (new RegExp(`^${topKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`).test(line)) { inside = true; continue; }
    if (inside && /^\S/.test(line)) break;
    if (!inside) continue;
    const m = line.match(/^\s{2}(['"]?)(.+?)\1\s*:\s*(['"]?)(.+?)\3\s*$/);
    if (m) out[m[2]] = m[4];
  }
  return out;
}

function yamlInfoVersion(src) {
  const m = src.match(/^info:\s*$([\s\S]*?)^\S/m) || src.match(/^info:\s*$([\s\S]*)/m);
  const block = m ? m[1] : '';
  const v = block.match(/^\s{2}version:\s*['"]?([^'"\s]+)/m);
  return v ? v[1] : null;
}

/* Deliberately only a major-version comparison. Anything cleverer would be a
   semver implementation, which is a dependency, which is the thing this file
   does not have. */
function satisfiesMajor(have, want) {
  const major = (s) => String(s).replace(/^[^0-9]*/, '').split('.')[0];
  return major(have) === major(want);
}

function report(ran, skipped) {
  console.log('Checked:');
  for (const r of ran) console.log('  ✓ ' + r);
  if (!ran.length) console.log('  (nothing)');
  if (skipped.length) {
    console.log('Not checked:');
    for (const s of skipped) console.log('  – ' + s);
  }
}

function fail(msg) {
  console.error('\n::error::Conformance gate failed.');
  console.error('  ' + msg + '\n');
  process.exit(1);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
