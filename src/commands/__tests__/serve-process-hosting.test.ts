/**
 * Serve process hosting helpers tests
 */

import { describe, expect, test } from 'bun:test';
import {
  buildServeIngressConfig,
  resolveCloudRelayUrlForConfig,
  type ProcessHostEntry,
} from '../serve';
import { buildProcessHostname, normalizeHostLabel } from '../../utils/hostnames';

describe('process hosting helpers', () => {
  test('normalizeHostLabel cleans and lowercases', () => {
    expect(normalizeHostLabel('My App')).toBe('my-app');
    expect(normalizeHostLabel('API__Server')).toBe('api-server');
    expect(normalizeHostLabel('---')).toBe('x');
  });

  test('buildProcessHostname assembles flattened segments', () => {
    const hostname = buildProcessHostname(
      'gitspace.sh',
      'brad',
      'my-workspace',
      'web-api',
      2,
      'web',
    );

    expect(hostname).toBe('web-api--my-workspace--web--2--brad-srv.gitspace.sh');
  });

  test('buildServeIngressConfig adds fallback', () => {
    const entries: ProcessHostEntry[] = [
      {
        hostname: 'api--alpha--web--1--brad-srv.gitspace.sh',
        service: 'http://127.0.0.1:3000',
        protocol: 'http',
        workspaceId: 'alpha',
        processName: 'api',
        instance: 1,
        port: 3000,
        portName: 'web',
      },
      {
        hostname: 'api--alpha--tcp--1--brad-srv.gitspace.sh',
        service: 'tcp://127.0.0.1:9000',
        protocol: 'tcp',
        workspaceId: 'alpha',
        processName: 'api',
        instance: 1,
        port: 9000,
        portName: 'tcp',
      },
    ];

    const config = buildServeIngressConfig(entries);
    expect(config).toContain('ingress:');
    expect(config).toContain('hostname: api--alpha--web--1--brad-srv.gitspace.sh');
    expect(config).toContain('service: http://127.0.0.1:3000');
    expect(config).toContain('hostname: api--alpha--tcp--1--brad-srv.gitspace.sh');
    expect(config).toContain('service: tcp://127.0.0.1:9000');
    expect(config).toContain('service: http_status:404');
  });

  test('resolveCloudRelayUrlForConfig derives hosted relay url for 0.0.0.0 binds', () => {
    expect(resolveCloudRelayUrlForConfig('ws://0.0.0.0:4480/ws', {
      subdomain: 'brad',
      createdAt: Date.now(),
    })).toBe('wss://brad.gitspace.sh/ws');
  });

  test('buildProcessHostname preserves field-boundary uniqueness', () => {
    const first = buildProcessHostname(
      'gitspace.sh',
      'brad',
      'alpha-beta',
      'api',
      1,
      'web',
    );
    const second = buildProcessHostname(
      'gitspace.sh',
      'brad',
      'alpha',
      'beta-api',
      1,
      'web',
    );

    expect(first).not.toBe(second);
  });

  test('buildProcessHostname keeps compact hostnames inside the owned -srv namespace', () => {
    const hostname = buildProcessHostname(
      'gitspace.sh',
      'bradleat',
      'figma-based-redesign',
      'sample-server',
      1,
      'web',
      'macbook-pro-2-local',
    );

    expect(hostname.length).toBeLessThanOrEqual(63 + '.gitspace.sh'.length);
    expect(hostname).toEndWith('--bradleat-srv.gitspace.sh');
  });
});
