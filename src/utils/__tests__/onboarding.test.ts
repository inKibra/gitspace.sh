/**
 * Tests for onboarding step execution with previous values support
 *
 * Note: These tests use dynamic imports to avoid mock interference
 * with other test files.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

describe('onboarding', () => {
  async function loadOnboardingModule() {
    const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return import(`../onboarding.ts?cacheBust=${cacheBust}`);
  }

  // Store references to mock functions
  let mockPromptInput: (message: string, options?: { default?: string }) => Promise<string | null>;
  let mockPromptPassword: () => Promise<string | null>;
  let mockPromptConfirm: () => Promise<boolean>;
  let mockSelectOne: <T>(options: Array<{ label: string; value: T; description?: string }>, message: string) => Promise<T | null>;
  beforeEach(() => {
    // Reset mock implementations to defaults
    mockPromptInput = async (_message: string, options?: { default?: string }) => {
      return options?.default ?? 'test-value';
    };
    mockPromptPassword = async () => 'secret-value';
    mockPromptConfirm = async () => true;
    mockSelectOne = async (options) => options[0]?.value ?? null;

    // Setup mocks before each test
    mock.module('../prompts', () => ({
      promptInput: async (message: string, options?: { default?: string; validate?: (v: string) => boolean | string }) => {
        return mockPromptInput(message, options);
      },
      promptPassword: async () => {
        return mockPromptPassword();
      },
      promptConfirm: async () => {
        return mockPromptConfirm();
      },
      selectOne: async <T>(options: Array<{ label: string; value: T; description?: string }>, message: string) => {
        return mockSelectOne(options, message);
      },
    }));

    mock.module('../deps', () => ({
      checkCommandExists: async () => true,
    }));

    mock.module('../logger', () => ({
      logger: {
        log: () => {},
        dim: () => {},
        bold: () => {},
        info: () => {},
        success: () => {},
        warning: () => {},
        error: () => {},
        debug: () => {},
      },
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  describe('KEEP_EXISTING_SECRET constant', () => {
    it('should export the constant', async () => {
      const { KEEP_EXISTING_SECRET } = await loadOnboardingModule();
      expect(KEEP_EXISTING_SECRET).toBe('__KEEP_EXISTING_SECRET__');
    });
  });

  describe('runOnboarding', () => {
    it('should complete with empty steps', async () => {
      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding([]);

      expect(result.completed).toBe(true);
      expect(result.inputValues).toEqual({});
      expect(result.secretValues).toEqual({});
    });

    it('should collect input values', async () => {
      mockPromptInput = async () => 'my-input';

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding([
        {
          id: 'name-step',
          type: 'input',
          title: 'Your Name',
          description: 'Enter your name',
          configKey: 'userName',
        },
      ]);

      expect(result.completed).toBe(true);
      expect(result.inputValues.userName).toBe('my-input');
    });

    it('should collect select values', async () => {
      mockSelectOne = async (options) => options.find((option) => option.value === 'green')?.value ?? null;

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding([
        {
          id: 'color-step',
          type: 'select',
          title: 'Color',
          description: 'Pick a color',
          configKey: 'favoriteColor',
          options: [
            { label: 'Red', value: 'red' },
            { label: 'Green', value: 'green' },
          ],
        },
      ]);

      expect(result.completed).toBe(true);
      expect(result.inputValues.favoriteColor).toBe('green');
    });

    it('should collect secret values', async () => {
      mockPromptPassword = async () => 'my-secret';

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding([
        {
          id: 'api-key',
          type: 'secret',
          title: 'API Key',
          description: 'Enter your API key',
          configKey: 'apiKey',
        },
      ]);

      expect(result.completed).toBe(true);
      expect(result.secretValues.apiKey).toBe('my-secret');
    });

    it('should handle info steps', async () => {
      mockPromptConfirm = async () => true;

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding([
        {
          id: 'welcome',
          type: 'info',
          title: 'Welcome',
          description: 'Welcome to the setup wizard',
        },
      ]);

      expect(result.completed).toBe(true);
    });

    it('should handle confirm steps', async () => {
      mockPromptConfirm = async () => true;

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding([
        {
          id: 'confirm-install',
          type: 'confirm',
          title: 'Confirm Installation',
          description: 'Please confirm you have installed the CLI',
        },
      ]);

      expect(result.completed).toBe(true);
    });

    it('should handle cancelled input', async () => {
      mockPromptInput = async () => null;

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding([
        {
          id: 'name-step',
          type: 'input',
          title: 'Your Name',
          description: 'Enter your name',
          configKey: 'userName',
        },
      ]);

      expect(result.completed).toBe(false);
      expect(result.cancelledAt).toBe('name-step');
    });

    it('should handle cancelled info step', async () => {
      mockPromptConfirm = async () => false;

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding([
        {
          id: 'welcome',
          type: 'info',
          title: 'Welcome',
          description: 'Welcome to the setup wizard',
        },
      ]);

      expect(result.completed).toBe(false);
      expect(result.cancelledAt).toBe('welcome');
    });

  });

  describe('runOnboarding with previous values', () => {
    it('should use previous value as default for input steps', async () => {
      // When user presses Enter (empty input), should use default
      mockPromptInput = async (_message: string, options?: { default?: string }) => {
        // Simulate pressing Enter - return the default value
        return options?.default ?? '';
      };

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding(
        [
          {
            id: 'name-step',
            type: 'input',
            title: 'Your Name',
            description: 'Enter your name',
            configKey: 'userName',
          },
        ],
        {
          previousValues: { userName: 'Previous Name' },
          isRefresh: true,
        }
      );

      expect(result.completed).toBe(true);
      // Should get the previous value since input returned the default
      expect(result.inputValues.userName).toBe('Previous Name');
    });

    it('should allow overriding previous value', async () => {
      mockPromptInput = async () => 'New Name';

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding(
        [
          {
            id: 'name-step',
            type: 'input',
            title: 'Your Name',
            description: 'Enter your name',
            configKey: 'userName',
          },
        ],
        {
          previousValues: { userName: 'Previous Name' },
          isRefresh: true,
        }
      );

      expect(result.completed).toBe(true);
      expect(result.inputValues.userName).toBe('New Name');
    });

    it('should return KEEP_EXISTING_SECRET when user keeps existing secret', async () => {
      // User confirms to keep existing
      mockPromptConfirm = async () => true;

      const { runOnboarding, KEEP_EXISTING_SECRET } = await loadOnboardingModule();
      const result = await runOnboarding(
        [
          {
            id: 'api-key',
            type: 'secret',
            title: 'API Key',
            description: 'Enter your API key',
            configKey: 'apiKey',
          },
        ],
        {
          previousSecretKeys: ['apiKey'],
          isRefresh: true,
        }
      );

      expect(result.completed).toBe(true);
      expect(result.secretValues.apiKey).toBe(KEEP_EXISTING_SECRET);
    });

    it('should prompt for new secret when user declines to keep existing', async () => {
      // First prompt: keep existing? No
      // Then prompt for new password
      let confirmCallCount = 0;

      mockPromptConfirm = async () => {
        confirmCallCount++;
        // First call is "keep existing?", return false
        // Subsequent calls return true
        return confirmCallCount > 1;
      };
      mockPromptPassword = async () => 'new-secret-value';

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding(
        [
          {
            id: 'api-key',
            type: 'secret',
            title: 'API Key',
            description: 'Enter your API key',
            configKey: 'apiKey',
          },
        ],
        {
          previousSecretKeys: ['apiKey'],
          isRefresh: true,
        }
      );

      expect(result.completed).toBe(true);
      expect(result.secretValues.apiKey).toBe('new-secret-value');
    });

    it('should not show keep existing prompt for new secrets', async () => {
      mockPromptPassword = async () => 'brand-new-secret';

      const { runOnboarding } = await loadOnboardingModule();
      const result = await runOnboarding(
        [
          {
            id: 'new-api-key',
            type: 'secret',
            title: 'New API Key',
            description: 'Enter a new API key',
            configKey: 'newApiKey',
          },
        ],
        {
          previousSecretKeys: ['otherKey'], // Different key
          isRefresh: true,
        }
      );

      expect(result.completed).toBe(true);
      expect(result.secretValues.newApiKey).toBe('brand-new-secret');
    });

    it('should handle multiple steps with mixed previous values', async () => {
      mockPromptInput = async (_message: string, options?: { default?: string }) => {
        return options?.default ?? '';
      };
      mockPromptConfirm = async () => true;

      const { runOnboarding, KEEP_EXISTING_SECRET } = await loadOnboardingModule();
      const result = await runOnboarding(
        [
          {
            id: 'name-step',
            type: 'input',
            title: 'Your Name',
            description: 'Enter your name',
            configKey: 'userName',
          },
          {
            id: 'api-key',
            type: 'secret',
            title: 'API Key',
            description: 'Enter your API key',
            configKey: 'apiKey',
          },
        ],
        {
          previousValues: { userName: 'Existing Name' },
          previousSecretKeys: ['apiKey'],
          isRefresh: true,
        }
      );

      expect(result.completed).toBe(true);
      expect(result.inputValues.userName).toBe('Existing Name');
      expect(result.secretValues.apiKey).toBe(KEEP_EXISTING_SECRET);
    });
  });
});
