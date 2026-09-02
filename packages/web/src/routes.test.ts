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

  it('preserves resource identity while replacing the application route', () => {
    const url = setProductRoute(new URL('https://gitspace.test/skills?project=project-a&workspace=space-a&machine=machine-a&rpc=%2Frpc&view=settings'), 'plugins');
    expect(url.pathname).toBe('/plugins');
    expect(url.searchParams.get('project')).toBe('project-a');
    expect(url.searchParams.get('workspace')).toBe('space-a');
    expect(url.searchParams.get('machine')).toBe('machine-a');
    expect(url.searchParams.get('rpc')).toBe('/rpc');
    expect(url.searchParams.has('view')).toBe(false);
  });

  it('keeps the legacy settings query as an inbound compatibility path', () => {
    expect(productRouteFromLocation({ pathname: '/', search: '?view=settings' })).toBe('settings');
    expect(productRouteFromLocation({ pathname: '/unknown', search: '' })).toBe('agent');
  });
});
