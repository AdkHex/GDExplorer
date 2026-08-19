#!/usr/bin/env node

/**
 * Refuses `npm install` / `yarn install` in this pnpm-only repo.
 *
 * Running `npm install` here produces a package-lock.json plus a node_modules
 * layout the project does not support. Worse, once that lockfile existed on a
 * machine it blocked `git pull` outright:
 *
 *   error: Your local changes to the following files would be overwritten by
 *   merge: package-lock.json
 *
 * pnpm-lock.yaml is the only lockfile, and CI installs from it. Wired up as the
 * `preinstall` script, so it runs before any install can write a lockfile.
 * `npm run <script>` does not trigger preinstall, so ordinary script use -
 * including `npm run tauri dev` - is unaffected.
 *
 * Deliberately dependency-free and offline: `npx only-allow pnpm` would need a
 * network round trip on first use, which breaks offline and cached CI installs.
 */

import { rmSync } from 'node:fs'

const userAgent = process.env.npm_config_user_agent ?? ''
const manager = userAgent.split('/')[0]

// No user agent means the script was invoked directly rather than by a package
// manager. Nothing to enforce, so stay out of the way.
if (userAgent && manager !== 'pnpm') {
  const name = manager || 'that package manager'

  // npm writes package-lock.json *before* it runs preinstall, so refusing the
  // install is not enough on its own - the file is already on disk by the time
  // we get here. Remove it so the working tree is left exactly as it was.
  const removed = ['package-lock.json', 'yarn.lock'].filter(file => {
    try {
      rmSync(file)
      return true
    } catch {
      return false
    }
  })

  process.stderr.write(
    `\n  This repository uses pnpm, but you ran ${name} install.\n\n` +
      `  ${name} would write its own lockfile and an incompatible node_modules\n` +
      `  tree. A stray package-lock.json is also what has blocked git pull here\n` +
      `  before.\n\n` +
      (removed.length ? `  Removed: ${removed.join(', ')}\n\n` : '') +
      `  Use pnpm instead:\n\n` +
      `      corepack enable      # once, if you do not have pnpm yet\n` +
      `      pnpm install\n\n` +
      `  If you genuinely need to bypass this check:\n\n` +
      `      ${name} install --ignore-scripts\n\n`
  )
  process.exit(1)
}
