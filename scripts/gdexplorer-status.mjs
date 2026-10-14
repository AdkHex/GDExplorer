#!/usr/bin/env node
// Remote switch and access password for installed copies of GDrive-Upload
// (docs/REMOTE-STATUS.md). Needs the GitHub CLI `gh`, logged in as AdkHex.
//
//   node scripts/gdexplorer-status.mjs status                 what the gist says now
//   node scripts/gdexplorer-status.mjs maintenance ["message"] [--title t] [--check-minutes n]
//   node scripts/gdexplorer-status.mjs ok [--min-version x|off] [--update-url u|off] [--check-minutes n]
//   node scripts/gdexplorer-status.mjs password               prompts twice (hidden), sets the password
//   node scripts/gdexplorer-status.mjs password --off         removes the password
//   node scripts/gdexplorer-status.mjs serve --serve 8799     serve the local file for testing
//
// Every change starts from the current document and changes only what it is
// asked to: maintenance keeps the password, password keeps the status.
//
// Options:
//   --no-publish     only write the local file (start from it too, if it exists)
//   --out <file>     local copy (default ./remote-status/status.json)
//   --serve <port>   serve the local file on http://127.0.0.1:<port>/status.json
//                    (implies --no-publish unless --publish is given)
//   --publish        publish even with --serve
//
// Without a terminal, `password` reads the password (and, if given, its
// repetition) from the first two lines of stdin. It is never printed or saved.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { URL, fileURLToPath } from 'node:url'

// ---- where the published document lives (the URL in src-tauri/remote-status.json)
const GIST_ID = '5fee5fd42bf01592e81143dd4ecd7a94'
const GIST_FILE = 'gdexplorer-status.json'
const RAW_URL = `https://gist.githubusercontent.com/AdkHex/${GIST_ID}/raw/${GIST_FILE}`

// Must match what the app accepts (src-tauri/src/remote_status.rs).
const ITERATIONS = 600000
const MIN_PASSWORD = 8

const argv = process.argv.slice(2)
const BOOL_FLAGS = ['--no-publish', '--publish', '--off', '--help', '-h']
const VALUE_FLAGS = [
  '--title',
  '--min-version',
  '--update-url',
  '--check-minutes',
  '--out',
  '--serve',
]
const flags = new Set(argv.filter(a => BOOL_FLAGS.includes(a)))
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const positional = argv.filter(
  (a, i) => !a.startsWith('-') && !VALUE_FLAGS.includes(argv[i - 1])
)
const [mode, message] = positional

function die(msg) {
  console.error(`gdexplorer-status: ${msg}`)
  process.exit(1)
}

function usage() {
  const text = fs
    .readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l.startsWith('//'))
    .map(l => l.slice(3))
  console.log(text.join('\n'))
}

function gh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    die(
      `gh ${args.join(' ')} failed: ${(e.stderr || e.message || '').toString().trim()}\n` +
        '(is the GitHub CLI installed and logged in as the gist owner?)'
    )
  }
}

function readPublished() {
  return gh(['gist', 'view', GIST_ID, '--raw', '--filename', GIST_FILE]).trim()
}

/** The document every change starts from. */
function baseDocument(local, out) {
  if (local) {
    if (!fs.existsSync(out)) return { status: 'ok', checkMinutes: 5 }
    try {
      return JSON.parse(fs.readFileSync(out, 'utf8'))
    } catch {
      die(`${out} is not valid JSON; fix or delete it first`)
    }
  }
  try {
    return JSON.parse(readPublished())
  } catch {
    die(
      'the published document is not valid JSON; refusing to build on it.\n' +
        `Check it with: gh gist view ${GIST_ID} --raw`
    )
  }
}

function packageVersion() {
  try {
    const pkg = new URL('../package.json', import.meta.url)
    return JSON.parse(fs.readFileSync(fileURLToPath(pkg), 'utf8')).version
  } catch {
    return null
  }
}

function versionParts(v) {
  return String(v)
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map(p => parseInt(p, 10) || 0)
}

function olderThan(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  }
  return false
}

/** Applies the options every mode shares. */
function applyCommonOptions(doc) {
  const minutes = opt('--check-minutes')
  if (minutes !== undefined) {
    const n = Number(minutes)
    if (!Number.isFinite(n) || n < 1 || n > 60)
      die('--check-minutes must be 1..60')
    doc.checkMinutes = Math.round(n)
  }
}

function applyStatus(doc) {
  doc.status = mode
  const title = opt('--title')
  if (mode === 'maintenance') {
    if (title) doc.title = title
    if (message) doc.message = message
  } else if (message || title) {
    die('ok takes no message or title')
  }

  const minVersion = opt('--min-version')
  if (minVersion === 'off') delete doc.minVersion
  else if (minVersion) {
    if (!/^v?\d+(\.\d+)*([-+].*)?$/.test(minVersion))
      die(`--min-version ${minVersion} is not a version like 1.0.2`)
    const current = packageVersion()
    if (current && olderThan(current, minVersion)) {
      console.warn(
        `warning: this checkout is ${current}, older than --min-version ${minVersion}. ` +
          'Ship a build at or above it first, or that build locks itself out too.'
      )
    }
    doc.minVersion = minVersion
  }

  const updateUrl = opt('--update-url')
  if (updateUrl === 'off') delete doc.updateUrl
  else if (updateUrl) {
    if (!/^https?:\/\//i.test(updateUrl))
      die('--update-url must be an http(s) address')
    doc.updateUrl = updateUrl
  }
}

/** Reads one line without echoing it. */
function promptHidden(question) {
  return new Promise(resolve => {
    const stdin = process.stdin
    process.stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const finish = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = chunk => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') return finish()
        if (c === '\u0003') {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (c === '\u007f' || c === '\b')
          value = Array.from(value).slice(0, -1).join('')
        else value += c
      }
    }
    stdin.on('data', onData)
  })
}

function readStdinLines() {
  const text = fs.readFileSync(0, 'utf8')
  return text.split(/\r?\n/)
}

async function askPassword() {
  let first
  let second
  if (process.stdin.isTTY) {
    first = await promptHidden('New access password: ')
    second = await promptHidden('Repeat it: ')
  } else {
    const lines = readStdinLines()
    first = lines[0] ?? ''
    second = lines.length > 1 && lines[1] !== '' ? lines[1] : first
  }
  if (first !== second) die('the two passwords differ; nothing changed')
  if (first.length < MIN_PASSWORD)
    die(`use at least ${MIN_PASSWORD} characters; nothing changed`)
  if (first.length < 12) {
    console.warn(
      'warning: the hash is readable by anyone with the gist link, so a short password can be guessed offline. A long passphrase is safer.'
    )
  }
  return first
}

function accessBlock(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256')
  const id = crypto
    .createHash('sha256')
    .update(Buffer.concat([salt, hash]))
    .digest('hex')
    .slice(0, 16)
  return {
    alg: 'pbkdf2-sha256',
    iterations: ITERATIONS,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    id,
  }
}

function describe(doc) {
  const lock =
    doc.status === 'maintenance'
      ? 'LOCKED (maintenance)'
      : doc.minVersion
        ? `ok, builds older than ${doc.minVersion} locked ("Update required")`
        : 'ok (running normally)'
  const access = doc.access
    ? `on (id ${doc.access.id ?? '?'}): every user enters it once`
    : 'off'
  return `${lock}\npassword: ${access}`
}

function writeLocal(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
  console.log(`wrote ${file}`)
}

/** Replace the gist file with the local document. Swap this out to move hosting. */
function publish(file) {
  gh(['gist', 'edit', GIST_ID, '--filename', GIST_FILE, file])
  console.log(`published to gist ${GIST_ID} (${RAW_URL})`)
  console.log(
    'installed copies see it within their checkMinutes plus up to 5 min of GitHub caching'
  )
}

function showPublished() {
  const raw = readPublished()
  try {
    const doc = JSON.parse(raw)
    // The hash is not secret, but there is no reason to print it either.
    const shown = doc.access
      ? { ...doc, access: { ...doc.access, salt: '…', hash: '…' } }
      : doc
    console.log(JSON.stringify(shown, null, 2))
    console.log(`\n${describe(doc)}`)
  } catch {
    console.log(raw)
    console.log(
      '\n(not valid JSON: installed copies ignore it and keep their last known state)'
    )
  }
}

function serve(file, port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/status.json') {
      res.writeHead(404).end('try /status.json')
      return
    }
    let body
    try {
      body = fs.readFileSync(file)
    } catch {
      res.writeHead(404).end('no status file yet')
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    res.end(body)
    let summary = '(not JSON)'
    try {
      const doc = JSON.parse(body)
      summary = `${doc.status}${doc.access ? ', password on' : ''}`
    } catch {
      /* served as is */
    }
    console.log(
      `${new Date().toLocaleTimeString()} GET ${req.url} -> ${summary}`
    )
  })
  server.listen(port, '127.0.0.1', () =>
    console.log(`serving ${file} on http://127.0.0.1:${port}/status.json`)
  )
}

// ---- main
if (flags.has('--help') || flags.has('-h') || !mode) {
  usage()
  process.exit(mode ? 0 : 1)
}
const out = path.resolve(opt('--out', 'remote-status/status.json'))
const port = opt('--serve') ? Number(opt('--serve')) : null
if (port != null && !(port > 0 && port < 65536))
  die('--serve needs a port number')
const shouldPublish =
  flags.has('--publish') || (!flags.has('--no-publish') && port == null)

switch (mode) {
  case 'status':
    showPublished()
    break
  case 'serve':
    if (port == null) die('serve needs --serve <port>')
    serve(out, port)
    break
  case 'ok':
  case 'maintenance':
  case 'password': {
    const doc = baseDocument(!shouldPublish, out)
    if (mode === 'password') {
      if (message) die('password takes no argument; it asks for the password')
      if (flags.has('--off')) {
        delete doc.access
        console.log('password removed: nobody is asked any more')
      } else {
        doc.access = accessBlock(await askPassword())
        console.log(
          `password set (id ${doc.access.id}): every user is asked for it once, ` +
            'including those who entered the previous one'
        )
      }
      if (typeof doc.status !== 'string') doc.status = 'ok'
    } else {
      if (flags.has('--off')) die('--off only goes with password')
      applyStatus(doc)
    }
    applyCommonOptions(doc)
    writeLocal(out, doc)
    console.log(describe(doc))
    if (shouldPublish) publish(out)
    else console.log('not published (local only)')
    if (port != null) serve(out, port)
    break
  }
  default:
    die(
      `unknown mode "${mode}" (use status, maintenance, ok, password or serve; --help for details)`
    )
}
