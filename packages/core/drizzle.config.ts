import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.GITSPACE_DATABASE_PATH ?? './gitspace.db',
  },
  strict: true,
  verbose: true,
});
