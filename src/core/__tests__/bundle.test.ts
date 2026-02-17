import { describe, expect, it } from 'bun:test';
import { validateBundle } from '../bundle';

describe('validateBundle', () => {
  it('allows unique config keys with distinct normalized aliases', () => {
    expect(() =>
      validateBundle({
        version: '1.0',
        name: 'Valid Bundle',
        onboarding: [
          {
            id: 'env-name',
            type: 'input',
            title: 'Environment Name',
            description: 'Name of environment',
            configKey: 'vercelEnv',
          },
          {
            id: 'api-token',
            type: 'secret',
            title: 'API Token',
            description: 'Service token',
            configKey: 'apiToken',
          },
        ],
      })
    ).not.toThrow();
  });

  it('throws helpful error when configKey is duplicated across steps', () => {
    expect(() =>
      validateBundle({
        version: '1.0',
        name: 'Duplicate Key Bundle',
        onboarding: [
          {
            id: 'api-token-input',
            type: 'input',
            title: 'API token input',
            description: 'input',
            configKey: 'apiToken',
          },
          {
            id: 'api-token-secret',
            type: 'secret',
            title: 'API token secret',
            description: 'secret',
            configKey: 'apiToken',
          },
        ],
      })
    ).toThrow(/Bundle configKey collision/);
  });

  it('throws helpful error when normalized aliases collide', () => {
    expect(() =>
      validateBundle({
        version: '1.0',
        name: 'Alias Collision Bundle',
        onboarding: [
          {
            id: 'api-token-dash',
            type: 'input',
            title: 'API token dash',
            description: 'dash',
            configKey: 'api-token',
          },
          {
            id: 'api-token-camel',
            type: 'secret',
            title: 'API token camel',
            description: 'camel',
            configKey: 'apiToken',
          },
        ],
      })
    ).toThrow(/Bundle configKey alias collision/);

    expect(() =>
      validateBundle({
        version: '1.0',
        name: 'Alias Collision Bundle',
        onboarding: [
          {
            id: 'api-token-dash',
            type: 'input',
            title: 'API token dash',
            description: 'dash',
            configKey: 'api-token',
          },
          {
            id: 'api-token-camel',
            type: 'secret',
            title: 'API token camel',
            description: 'camel',
            configKey: 'apiToken',
          },
        ],
      })
    ).toThrow(/API_TOKEN/);
  });

  it('detects exact key and normalized alias collisions', () => {
    expect(() =>
      validateBundle({
        version: '1.0',
        name: 'Exact Alias Collision Bundle',
        onboarding: [
          {
            id: 'exact-upper',
            type: 'input',
            title: 'Exact upper',
            description: 'exact',
            configKey: 'API_TOKEN',
          },
          {
            id: 'camel-key',
            type: 'secret',
            title: 'Camel key',
            description: 'camel',
            configKey: 'apiToken',
          },
        ],
      })
    ).toThrow(/Bundle configKey alias collision/);
  });
});
