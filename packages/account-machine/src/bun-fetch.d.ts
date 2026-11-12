// Bun's fetch takes `timeout: false` to drop its default 300 s limit; bun-types 1.3.14 does not declare the option.
declare global {
  interface BunFetchRequestInit {
    timeout?: boolean;
  }
}
export {};
