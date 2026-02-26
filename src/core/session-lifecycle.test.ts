import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectForSession } from './session-lifecycle.js'
import { getProjectDir, projectExists, readProjectConfig } from './config.js'

let originalHome: string | undefined
let testHomeDir: string
let createdProjectDirs: string[]

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('session lifecycle project creation', () => {
  beforeEach(() => {
    originalHome = process.env.HOME
    testHomeDir = mkdtempSync(join(tmpdir(), 'gssh-session-lifecycle-'))
    process.env.HOME = testHomeDir
    createdProjectDirs = []
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }

    if (testHomeDir && existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true })
    }

    for (const projectDir of createdProjectDirs) {
      if (existsSync(projectDir)) {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  })

  test('creates project from file:// git remote URL', async () => {
    const sourceDir = join(testHomeDir, 'source-repo')
    const remoteDir = join(testHomeDir, 'remote-repo.git')

    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(remoteDir, { recursive: true, force: true })

    git(['init', '-b', 'main', sourceDir], testHomeDir)
    writeFileSync(join(sourceDir, 'README.md'), '# test\n', 'utf8')
    git(['add', 'README.md'], sourceDir)
    git([
      '-c', 'user.name=Test User',
      '-c', 'user.email=test@example.com',
      'commit', '-m', 'init',
    ], sourceDir)
    git(['clone', '--bare', sourceDir, remoteDir], testHomeDir)

    const repository = `file://${remoteDir}`
    const projectName = `demo-project-${Date.now().toString(36)}`
    const result = await createProjectForSession({
      repository,
      projectName,
      setCurrent: false,
    })
    createdProjectDirs.push(getProjectDir(projectName))

    expect(result.projectName).toBe(projectName)
    expect(result.repository).toBe(repository)
    expect(result.baseBranch).toBe('main')
    expect(projectExists(projectName)).toBe(true)

    const config = readProjectConfig(projectName)
    expect(config.repository).toBe(repository)
    expect(config.baseBranch).toBe('main')
  })

  test('rejects invalid repository format', async () => {
    await expect(createProjectForSession({
      repository: 'not a valid repository',
      projectName: 'bad-project',
    })).rejects.toThrow(/git remote URL or owner\/repo shorthand/i)
  })
})
