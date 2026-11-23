import { describe, expect, it } from 'vitest';
import { BOARD_GROUP_PARAM, BOARD_PROJECTS_PARAM, productPath, productRouteFromLocation, setProductRoute } from './routes.js';

describe('stable product routes', () => {
  it('maps every durable path to its application view', () => {
    expect(productPath('agent')).toBe('/');
    expect(productPath('board')).toBe('/board');
    expect(productPath('projects')).toBe('/projects');
    expect(productPath('inference')).toBe('/inference');
    expect(productPath('plugins')).toBe('/plugins');
    expect(productPath('skills')).toBe('/skills');
    expect(productPath('automations')).toBe('/automations');
    expect(productPath('secrets')).toBe('/secrets');
    expect(productPath('monitoring')).toBe('/monitoring');
    expect(productPath('settings')).toBe('/settings');
    expect(productRouteFromLocation({ pathname: '/plugins/', search: '?project=project-a' })).toBe('plugins');
    expect(productRouteFromLocation({ pathname: '/inference', search: '?profile=client-a' })).toBe('inference');
  });

  it('leaves workspace selection behind when opening a global destination', () => {
    const url = setProductRoute(new URL('https://gitspace.test/?project=project-a&workspace=space-a&machine=machine-a&rpc=%2Frpc&view=settings'), 'projects');
    expect(url.pathname).toBe('/projects');
    expect(url.searchParams.has('project')).toBe(false);
    expect(url.searchParams.has('workspace')).toBe(false);
    expect(url.searchParams.get('machine')).toBe('machine-a');
    expect(url.searchParams.get('rpc')).toBe('/rpc');
    expect(url.searchParams.has('view')).toBe(false);
  });

  it('keeps the workspace open beside the board, and leaves the board parameters behind elsewhere', () => {
    const board = setProductRoute(new URL('https://gitspace.test/?project=project-a&workspace=space-a'), 'board');
    expect(board.pathname).toBe('/board');
    expect(board.searchParams.get('project')).toBe('project-a');
    expect(board.searchParams.get('workspace')).toBe('space-a');
    board.searchParams.set(BOARD_GROUP_PARAM, 'phase');
    board.searchParams.set(BOARD_PROJECTS_PARAM, 'project-a');
    const list = setProductRoute(board, 'agent');
    expect(list.pathname).toBe('/');
    expect(list.searchParams.get('workspace')).toBe('space-a');
    expect(list.searchParams.has(BOARD_GROUP_PARAM)).toBe(false);
    expect(list.searchParams.has(BOARD_PROJECTS_PARAM)).toBe(false);
  });

  it('keeps an explicitly selected workspace when opening its agent', () => {
    const url = setProductRoute(new URL('https://gitspace.test/projects?project=project-b&workspace=space-b'), 'agent');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('project')).toBe('project-b');
    expect(url.searchParams.get('workspace')).toBe('space-b');
  });

  it('keeps the legacy settings query as an inbound compatibility path', () => {
    expect(productRouteFromLocation({ pathname: '/', search: '?view=settings' })).toBe('settings');
    expect(productRouteFromLocation({ pathname: '/unknown', search: '' })).toBe('agent');
  });
});
