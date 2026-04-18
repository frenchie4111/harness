import { execFile } from 'child_process'
import { mkdir, writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { log } from './debug'

const execFileAsync = promisify(execFile)

export type GitignorePreset = 'none' | 'node' | 'python' | 'macos'

const MACOS_IGNORE = `.DS_Store
.AppleDouble
.LSOverride
Icon

._*
.Spotlight-V100
.Trashes
`

const NODE_IGNORE = `node_modules/
dist/
build/
.env
.env.local
*.log
.DS_Store
`

const PYTHON_IGNORE = `__pycache__/
*.py[cod]
*$py.class
.venv/
venv/
dist/
build/
*.egg-info/
.env
.DS_Store
`

function gitignoreContent(preset: GitignorePreset): string | null {
  if (preset === 'macos') return MACOS_IGNORE
  if (preset === 'node') return NODE_IGNORE
  if (preset === 'python') return PYTHON_IGNORE
  return null
}

export interface CreateNewProjectOpts {
  parentDir: string
  name: string
  includeReadme: boolean
  gitignorePreset: GitignorePreset
}

export type CreateNewProjectResult = { path: string } | { error: string }

const VALID_NAME = /^[^/\\:*?"<>|\x00]+$/

export function validateProjectName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name is required'
  if (trimmed === '.' || trimmed === '..') return 'Invalid name'
  if (!VALID_NAME.test(trimmed)) return 'Name contains invalid characters'
  return null
}

export async function createNewProject(
  opts: CreateNewProjectOpts
): Promise<CreateNewProjectResult> {
  const name = opts.name.trim()
  const nameError = validateProjectName(name)
  if (nameError) return { error: nameError }
  if (!opts.parentDir) return { error: 'Location is required' }

  const targetPath = join(opts.parentDir, name)
  if (existsSync(targetPath)) return { error: 'Directory already exists' }

  try {
    await mkdir(targetPath, { recursive: true })
    await execFileAsync('git', ['init'], { cwd: targetPath })

    if (opts.includeReadme) {
      await writeFile(join(targetPath, 'README.md'), `# ${name}\n`, 'utf-8')
    }

    const ignore = gitignoreContent(opts.gitignorePreset)
    if (ignore) {
      await writeFile(join(targetPath, '.gitignore'), ignore, 'utf-8')
    }

    await execFileAsync('git', ['add', '.'], { cwd: targetPath })
    await execFileAsync(
      'git',
      ['commit', '--allow-empty', '-m', 'Initial commit'],
      { cwd: targetPath }
    )

    return { path: targetPath }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log('repo-create', `createNewProject failed for ${targetPath}: ${message}`)
    try {
      await rm(targetPath, { recursive: true, force: true })
    } catch (cleanupErr) {
      log(
        'repo-create',
        `createNewProject cleanup failed for ${targetPath}: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`
      )
    }
    return { error: `Failed to create project: ${message}` }
  }
}
