#!/usr/bin/env node

/**
 * Runs a shell command with the rustup bin directory on PATH.
 *
 * The rust:* and tauri:dev scripts used to start with `source ~/.cargo/env`,
 * which is a POSIX shell builtin. On Windows cmd.exe that fails immediately
 * with "'source' is not recognized", so none of those scripts could run there.
 *
 * rustup installs to ~/.cargo/bin on every platform (%USERPROFILE%\.cargo\bin
 * on Windows), so prepending that directory does the same job portably. If
 * cargo is already on PATH this is a no-op.
 *
 * Callers pass a plain, unquoted command so nothing has to survive nested
 * quoting through cmd.exe:
 *
 *   node scripts/with-cargo.js cargo test --manifest-path src-tauri/Cargo.toml
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const command = process.argv.slice(2).join(' ')

if (!command) {
  console.error('usage: node scripts/with-cargo.js <command>')
  process.exit(1)
}

const cargoBin = join(homedir(), '.cargo', 'bin')
const currentPath = process.env.PATH ?? ''
const alreadyOnPath = currentPath
  .split(delimiter)
  .some(entry => entry.replace(/[\\/]+$/, '') === cargoBin)

const env = { ...process.env }
if (existsSync(cargoBin) && !alreadyOnPath) {
  env.PATH = `${cargoBin}${delimiter}${currentPath}`
}

// `shell: true` lets a single string carry `cd x && cargo y`, which behaves the
// same in cmd.exe and in sh.
const child = spawn(command, { stdio: 'inherit', shell: true, env })

child.on('error', error => {
  console.error(`Failed to run: ${command}`)
  console.error(error.message)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})
