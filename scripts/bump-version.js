#!/usr/bin/env node

/**
 * Bumps the app version everywhere it is written down.
 *
 * The version lives in four files, and they have to agree: the updater compares
 * the version in the release manifest against the one compiled into the running
 * app, so a mismatch means either no update is offered or the same update is
 * offered forever.
 *
 * CI calls this on every push to main to publish a new release. It also works by
 * hand:
 *
 *   node scripts/bump-version.js patch     # 0.2.5 -> 0.2.6
 *   node scripts/bump-version.js minor     # 0.2.5 -> 0.3.0
 *   node scripts/bump-version.js 1.0.0     # explicit
 *
 * Prints the new version on stdout and nothing else, so callers can capture it.
 */

import fs from 'node:fs'

const PACKAGE_JSON = 'package.json'
const TAURI_CONF = 'src-tauri/tauri.conf.json'
const CARGO_TOML = 'src-tauri/Cargo.toml'
const CARGO_LOCK = 'src-tauri/Cargo.lock'

function fail(message) {
  console.error(`bump-version: ${message}`)
  process.exit(1)
}

function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump

  const parts = current.split('.').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    fail(`current version "${current}" is not major.minor.patch`)
  }

  const [major, minor, patch] = parts
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    default:
      return fail(`unknown bump "${bump}" (use major, minor, patch or x.y.z)`)
  }
}

/**
 * Rewrites the top-level `"version"` line in place.
 *
 * Deliberately textual rather than parse-and-stringify: re-serialising
 * `tauri.conf.json` reflows arrays that Prettier keeps on one line, and
 * `format:check` would fail on the very commit CI just pushed.
 */
function replaceJsonVersion(file, version) {
  const source = fs.readFileSync(file, 'utf8')
  // Exactly two spaces of indent, so nested "version" keys cannot match.
  const pattern = /^( {2}"version": ")[^"]*(")/m
  if (!pattern.test(source)) fail(`no top-level version found in ${file}`)
  fs.writeFileSync(file, source.replace(pattern, `$1${version}$2`))
}

const bump = process.argv[2] ?? 'patch'

const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
const version = nextVersion(pkg.version, bump)

replaceJsonVersion(PACKAGE_JSON, version)
replaceJsonVersion(TAURI_CONF, version)

// Only the [package] version at the top of the manifest; dependency versions
// further down must not be touched.
const cargoToml = fs.readFileSync(CARGO_TOML, 'utf8')
const bumpedToml = cargoToml.replace(
  /^(\[package\][\s\S]*?^version = ")[^"]*(")/m,
  `$1${version}$2`
)
if (bumpedToml === cargoToml)
  fail(`no [package] version found in ${CARGO_TOML}`)
fs.writeFileSync(CARGO_TOML, bumpedToml)

// The lockfile records this crate's own version too. Left stale it shows up as
// a dirty file after the next build, and CI would commit it on the following
// release instead of this one.
const cargoLock = fs.readFileSync(CARGO_LOCK, 'utf8')
const bumpedLock = cargoLock.replace(
  /(name = "gdexplorer"\nversion = ")[^"]*(")/,
  `$1${version}$2`
)
if (bumpedLock === cargoLock) fail(`no gdexplorer entry found in ${CARGO_LOCK}`)
fs.writeFileSync(CARGO_LOCK, bumpedLock)

process.stdout.write(version)
