import { describe, expect, it } from 'bun:test'
import {
  resolveAttachCancelledTransition,
  resolveAttachErrorTransition,
  resolveAttachSuccessTransition,
} from './resolveAttachTransition.js'

describe('resolveAttachSuccessTransition', () => {
  it('keeps workspace detail open for ordinary inline attaches and resets switching state', () => {
    expect(resolveAttachSuccessTransition({ view: 'workspace-detail' })).toEqual({
      nextView: null,
      resetSessionSwitching: true,
    })
  })

  it('keeps command-driven attaches inline on workspace detail and resets switching state', () => {
    expect(resolveAttachSuccessTransition({ view: 'workspace-detail', command: 'gssh' })).toEqual({
      nextView: null,
      resetSessionSwitching: true,
    })
  })

  it('navigates non-detail attaches into terminal', () => {
    expect(resolveAttachSuccessTransition({ view: 'projects', command: 'gssh' })).toEqual({
      nextView: 'terminal',
      resetSessionSwitching: false,
    })
  })
})

describe('resolveAttachCancelledTransition', () => {
  it('stays in scripts on cancelled workspace attach and resets switching state', () => {
    expect(resolveAttachCancelledTransition({ view: 'scripts', target: 'workspace' })).toEqual({
      nextView: null,
      resetSessionSwitching: true,
    })
  })

  it('returns to projects for cancelled session attach', () => {
    expect(resolveAttachCancelledTransition({ view: 'terminal', target: 'session' })).toEqual({
      nextView: 'projects',
      resetSessionSwitching: true,
    })
  })
})

describe('resolveAttachErrorTransition', () => {
  it('stays in scripts for workspace script failures and resets switching state', () => {
    expect(resolveAttachErrorTransition({
      view: 'scripts',
      target: 'workspace',
      message: 'Workspace scripts failed during setup: boom',
    })).toEqual({
      nextView: null,
      resetSessionSwitching: true,
      isWorkspaceScriptFailure: true,
    })
  })

  it('returns to projects for non-script attach errors', () => {
    expect(resolveAttachErrorTransition({
      view: 'workspace-detail',
      target: 'workspace',
      message: 'Failed to attach session',
    })).toEqual({
      nextView: 'projects',
      resetSessionSwitching: true,
      isWorkspaceScriptFailure: false,
    })
  })
})
