import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { Window } from 'happy-dom'
import { useLifecycleController } from '../useLifecycleController.js'

const domWindow = new Window()
const originalWindow = globalThis.window
const originalDocument = globalThis.document

beforeAll(() => {
  // @ts-expect-error test DOM setup
  globalThis.window = domWindow
  // @ts-expect-error test DOM setup
  globalThis.document = domWindow.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
})

type SelectCall<T> = {
  title: string
  onSelect: (value: T) => void | Promise<void>
}

type InputCall = {
  title: string
  onSubmit: (value: string) => void | Promise<void>
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useLifecycleController project flow', () => {
  it('creates a project from manual git remote input', async () => {
    const showSelectCalls: Array<SelectCall<'manual' | 'github'>> = []
    const showInputCalls: InputCall[] = []
    const showMessage = mock(() => {})
    const showLoading = mock(() => {})

    const listGithubRepos = mock(async () => ['acme/app'])
    const createProject = mock(async () => {})
    const refreshProjects = mock(async () => {})
    const refreshWorkspaces = mock(async () => {})
    const refreshSessions = mock(async () => {})

    const { result } = renderHook(() =>
      useLifecycleController({
        flow: {
          showLoading,
          showSelect: (opts) => {
            showSelectCalls.push({
              title: opts.title,
              onSelect: opts.onSelect as (value: 'manual' | 'github') => void | Promise<void>,
            })
          },
          showInput: (opts) => {
            showInputCalls.push({ title: opts.title, onSubmit: opts.onSubmit })
          },
          showConfirmTyped: () => {},
          showMessage,
          close: () => {},
        },
        listGithubRepos,
        listRemoteBranches: async () => [],
        listLinearIssues: async () => [],
        createProject,
        createWorkspace: async () => {},
        deleteProject: async () => {},
        getProjectNames: () => [],
        refreshProjects,
        refreshWorkspaces,
        refreshSessions,
      })
    )

    result.current.openCreateProjectFlow()
    expect(showSelectCalls.length).toBe(1)
    expect(showSelectCalls[0]?.title).toBe('Create Project From')

    await showSelectCalls[0]!.onSelect('manual')
    expect(showInputCalls.length).toBe(1)
    expect(showInputCalls[0]?.title).toBe('Repository Remote')

    await showInputCalls[0]!.onSubmit('https://github.com/acme/widgets.git')
    expect(showInputCalls.length).toBe(2)
    expect(showInputCalls[1]?.title).toBe('Project Name')

    await showInputCalls[1]!.onSubmit('widgets')

    expect(createProject).toHaveBeenCalledWith({
      repository: 'https://github.com/acme/widgets.git',
      projectName: 'widgets',
    })
    expect(refreshProjects).toHaveBeenCalledTimes(1)
    expect(refreshWorkspaces).toHaveBeenCalledTimes(1)
    expect(refreshSessions).toHaveBeenCalledTimes(1)
    expect(showLoading).toHaveBeenCalledTimes(1)
    expect(showMessage).toHaveBeenCalledTimes(1)
  })

  it('supports optional GitHub repository picker when available', async () => {
    const showSelectCalls: Array<SelectCall<string>> = []
    const showInputCalls: InputCall[] = []
    const close = mock(() => {})

    const listGithubRepos = mock(async () => ['acme/api', 'acme/web'])
    const createProject = mock(async () => {})

    const { result } = renderHook(() =>
      useLifecycleController({
        flow: {
          showLoading: () => {},
          showSelect: (opts) => {
            showSelectCalls.push({
              title: opts.title,
              onSelect: opts.onSelect as (value: string) => void | Promise<void>,
            })
          },
          showInput: (opts) => {
            showInputCalls.push({ title: opts.title, onSubmit: opts.onSubmit })
          },
          showConfirmTyped: () => {},
          showMessage: () => {},
          close,
        },
        listGithubRepos,
        listRemoteBranches: async () => [],
        listLinearIssues: async () => [],
        createProject,
        createWorkspace: async () => {},
        deleteProject: async () => {},
        getProjectNames: () => [],
        refreshProjects: async () => {},
        refreshWorkspaces: async () => {},
      })
    )

    result.current.openCreateProjectFlow()
    await showSelectCalls[0]!.onSelect('github')
    await flushMicrotasks()

    expect(listGithubRepos).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(showSelectCalls.length).toBe(2)
    expect(showSelectCalls[1]?.title).toBe('Select Repository')

    await showSelectCalls[1]!.onSelect('acme/web')
    expect(showInputCalls.length).toBe(1)
    await showInputCalls[0]!.onSubmit('web')

    expect(createProject).toHaveBeenCalledWith({
      repository: 'acme/web',
      projectName: 'web',
    })
  })

  it('falls back to manual entry when GitHub listing fails', async () => {
    const showSelectCalls: Array<SelectCall<string>> = []
    const showInputCalls: InputCall[] = []
    const showMessage = mock(() => {})

    const listGithubRepos = mock(async () => {
      throw new Error('GitHub CLI unavailable')
    })

    const { result } = renderHook(() =>
      useLifecycleController({
        flow: {
          showLoading: () => {},
          showSelect: (opts) => {
            showSelectCalls.push({
              title: opts.title,
              onSelect: opts.onSelect as (value: string) => void | Promise<void>,
            })
          },
          showInput: (opts) => {
            showInputCalls.push({ title: opts.title, onSubmit: opts.onSubmit })
          },
          showConfirmTyped: () => {},
          showMessage,
          close: () => {},
        },
        listGithubRepos,
        listRemoteBranches: async () => [],
        listLinearIssues: async () => [],
        createProject: async () => {},
        createWorkspace: async () => {},
        deleteProject: async () => {},
        getProjectNames: () => [],
        refreshProjects: async () => {},
        refreshWorkspaces: async () => {},
      })
    )

    result.current.openCreateProjectFlow()
    await showSelectCalls[0]!.onSelect('github')
    await flushMicrotasks()

    expect(showMessage).toHaveBeenCalledTimes(1)
    expect(showInputCalls.length).toBe(1)
    expect(showInputCalls[0]?.title).toBe('Repository Remote')
  })
})
