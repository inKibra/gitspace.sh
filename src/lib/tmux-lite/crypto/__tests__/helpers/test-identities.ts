/**
 * Test identity generation helpers
 *
 * Provides utilities for generating test identities and public identity objects
 * for use in integration tests.
 */

import { generateIdentity, getPublicIdentity } from "../../identity.js";
import type { Identity, PublicIdentity } from "../../../../../types/identity.js";

/**
 * Generate a test identity with optional label
 *
 * @param label - Optional label for the identity
 * @returns Complete test identity
 *
 * @example
 * ```typescript
 * const alice = createTestIdentity("Alice");
 * const bob = createTestIdentity("Bob");
 * ```
 */
export function createTestIdentity(label?: string): Identity {
  return generateIdentity(label);
}

/**
 * Create a pair of test identities (client and machine)
 *
 * @param clientLabel - Label for client identity
 * @param machineLabel - Label for machine identity
 * @returns Object with client and machine identities
 *
 * @example
 * ```typescript
 * const { client, machine } = createTestIdentityPair();
 * ```
 */
export function createTestIdentityPair(
  clientLabel = "Test Client",
  machineLabel = "Test Machine"
): { client: Identity; machine: Identity } {
  return {
    client: createTestIdentity(clientLabel),
    machine: createTestIdentity(machineLabel),
  };
}

/**
 * Create multiple test identities
 *
 * @param count - Number of identities to create
 * @param labelPrefix - Prefix for identity labels
 * @returns Array of identities
 *
 * @example
 * ```typescript
 * const clients = createTestIdentities(5, "Client");
 * // Creates: "Client 1", "Client 2", etc.
 * ```
 */
export function createTestIdentities(
  count: number,
  labelPrefix = "Identity"
): Identity[] {
  return Array.from({ length: count }, (_, i) =>
    createTestIdentity(`${labelPrefix} ${i + 1}`)
  );
}

/**
 * Get public identity from a complete identity
 *
 * Wrapper around getPublicIdentity for convenience
 *
 * @param identity - Complete identity
 * @returns Public identity (safe to share)
 */
export function toPublicIdentity(identity: Identity): PublicIdentity {
  return getPublicIdentity(identity);
}

/**
 * Create a fixture set of identities for testing
 *
 * Returns a pre-configured set of identities with meaningful names
 * for common testing scenarios.
 *
 * @example
 * ```typescript
 * const fixtures = createIdentityFixtures();
 * // fixtures.alice - Client identity
 * // fixtures.bob - Another client
 * // fixtures.machine - Machine/server identity
 * // fixtures.untrusted - Identity not in access list
 * ```
 */
export function createIdentityFixtures(): {
  alice: Identity;
  bob: Identity;
  machine: Identity;
  untrusted: Identity;
  alicePublic: PublicIdentity;
  bobPublic: PublicIdentity;
  machinePublic: PublicIdentity;
  untrustedPublic: PublicIdentity;
} {
  const alice = createTestIdentity("Alice (Client)");
  const bob = createTestIdentity("Bob (Client)");
  const machine = createTestIdentity("Test Machine");
  const untrusted = createTestIdentity("Untrusted Client");

  return {
    alice,
    bob,
    machine,
    untrusted,
    alicePublic: toPublicIdentity(alice),
    bobPublic: toPublicIdentity(bob),
    machinePublic: toPublicIdentity(machine),
    untrustedPublic: toPublicIdentity(untrusted),
  };
}

/**
 * Create an access control list pre-populated with test identities
 *
 * @param acl - AccessControlList to populate
 * @param identities - Identities to add to the list
 * @param accessType - Access type to grant (optional, default: 'full')
 * @param sessionId - Session ID for view (optional)
 */
export function populateAccessList(
  acl: import("../../access-control.js").AccessControlList,
  identities: Identity[],
  accessType?: import("../../../../../types/identity.js").AccessType,
  sessionId?: string
): void {
  for (const identity of identities) {
    acl.addEntry(toPublicIdentity(identity), accessType, sessionId);
  }
}
