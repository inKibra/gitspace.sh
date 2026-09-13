import { afterAll, afterEach, beforeAll } from 'vitest';
import { reset } from 'cloudflare:test';
import { network } from './network.js';

beforeAll(() => network.enable());
afterEach(async () => { network.resetHandlers(); await reset(); });
afterAll(() => network.disable());
