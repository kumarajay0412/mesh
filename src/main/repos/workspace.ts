// Workspace repo discovery: the user points Mesh at the folder holding their
// existing clones (e.g. ~/Documents/GitHub) — no cloning, their git auth,
// read-only usage. The agent session gets this folder as cwd so
// git log/blame/show and rg work across every repo (Section 6.1).
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/** Immediate subdirectories that are git repos (have a .git entry). */
export function scanGitRepos(root: string): string[] {
  const abs = expandHome(root)
  if (!existsSync(abs)) return []
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .filter((e) => existsSync(join(abs, e.name, '.git')))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}
