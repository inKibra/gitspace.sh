import { expect, test } from "bun:test";
import { ready } from "./proof";
test("requires evidence", () => expect(ready({ id: "a", state: "ready", evidence: ["report"] })).toBe(true));
