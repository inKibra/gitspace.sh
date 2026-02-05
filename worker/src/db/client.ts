import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../types";

export function getDb(env: Env) {
  return drizzle(env.DB);
}
