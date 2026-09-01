import { expect, test } from "bun:test";
import { authorityLayers } from "./authority";
test("keeps typed layers", () => expect(authorityLayers).toHaveLength(5));
