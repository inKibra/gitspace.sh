import { afterAll, afterEach, beforeAll } from 'vitest';
import { network } from './network.js';

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
