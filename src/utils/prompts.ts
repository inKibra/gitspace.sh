/**
 * User prompt utilities using @inquirer/prompts
 */

import { search, input, confirm, password } from '@inquirer/prompts';

/**
 * Select an item from a searchable list
 * @param items Array of items to select from
 * @param message Prompt message
 * @returns Selected item or null if cancelled
 */
export async function selectItem(
  items: string[],
  message: string
): Promise<string | null> {
  if (items.length === 0) {
    return null;
  }

  try {
    const selected = await search({
      message,
      source: async (input) => {
        if (!input) {
          return items.map((item) => ({ name: item, value: item }));
        }

        // Filter items based on input
        const filtered = items.filter((item) =>
          item.toLowerCase().includes(input.toLowerCase())
        );

        return filtered.map((item) => ({ name: item, value: item }));
      },
    });

    return selected;
  } catch (error) {
    // User cancelled (Ctrl+C)
    return null;
  }
}

/**
 * Prompt for text input
 * @param message Prompt message
 * @param options Additional options
 * @returns Input value or null if cancelled
 */
export async function promptInput(
  message: string,
  options: {
    default?: string;
    validate?: (value: string) => boolean | string;
  } = {}
): Promise<string | null> {
  try {
    const value = await input({
      message,
      default: options.default,
      validate: options.validate,
    });

    return value;
  } catch (error) {
    // User cancelled (Ctrl+C)
    return null;
  }
}

/**
 * Prompt for confirmation
 * @param message Prompt message
 * @param defaultValue Default value
 * @returns Boolean response
 */
export async function promptConfirm(
  message: string,
  defaultValue = false
): Promise<boolean> {
  try {
    const value = await confirm({
      message,
      default: defaultValue,
    });

    return value;
  } catch (error) {
    // User cancelled (Ctrl+C), treat as false
    return false;
  }
}

/**
 * Prompt for password input
 * @param message Prompt message
 * @returns Password value or null if cancelled
 */
export async function promptPassword(
  message: string
): Promise<string | null> {
  try {
    const value = await password({
      message,
      mask: true,
    });

    return value;
  } catch (error) {
    // User cancelled (Ctrl+C)
    return null;
  }
}
