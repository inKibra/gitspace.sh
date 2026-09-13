import { describe, expect, it } from 'vitest';
import { productPath, productRouteFromLocation, setProductRoute } from './routes.js';

describe('stable product routes', () => {
  it('maps every durable path to its application view', () => {
    expect(productPath('agent')).toBe('/');
    expect(productPath('kanban')).toBe('/kanban');
    expect(productPath('projects')).toBe('/projects');
    expect(productPath('plugins')).toBe('/plugins');
    expect(productPath('skills')).toBe('/skills');
    expect(productPath('crons')).toBe('/crons');
    expect(productPath('secrets')).toBe('/secrets');
    expect(productPath('inbox')).toBe('/inbox');
    expect(productPath('settings')).toBe('/settings');
    expect(productRouteFromLocation({ pathname: '/plugins/', search: '?project=project-a' })).toBe('plugins');
  });

  it('leaves workspace selection behind when opening a global destination', () => {
    const url = setProductRoute(new URL('https://gitspace.test/?project=project-a&workspace=space-a&machine=machine-a&rpc=%2Frpc&view=settings'), 'kanban');
    expect(url.pathname).toBe('/kanban');
    expect(url.searchParams.has('project')).toBe(false);
    expect(url.searchParams.has('workspace')).toBe(false);
    expect(url.searchParams.get('machine')).toBe('machine-a');
    expect(url.searchParams.get('rpc')).toBe('/rpc');
    expect(url.searchParams.has('view')).toBe(false);
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
