/**
 * Identity file operations for managing keypairs, access lists, and machine identity
 *
 * This module handles persistent storage of cryptographic identities and access control:
 * - Encrypted keypair storage (password-protected)
 * - Access list management (authorized public keys)
 * - Machine identity configuration
 *
 * Directory structure:
 *   ~/gitspace/.identity/
 *   ├── keypair.json      # Encrypted identity keypair
 *   ├── access-list.json  # Allowed public keys
 *   └── machine.json      # Machine registration info
 *
 * @module identity
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
	Identity,
	PublicIdentity,
	AccessEntry,
	AccessType,
	MachineIdentity,
} from '../types/identity.js';
import {
	generateIdentity,
	serializeIdentity,
	deserializeIdentity,
	getPublicIdentity,
} from '../lib/tmux-lite/crypto/identity.js';
import { DEFAULT_ACCESS_TYPE } from '../lib/tmux-lite/crypto/access-control.js';
import { seal, open } from '../lib/tmux-lite/crypto/secretbox.js';
import { deriveKey, generateSalt } from '../lib/tmux-lite/crypto/keys.js';
import { getSpacesDir } from './config.js';
import {
	SpacesError,
	NoIdentityError,
	InvalidPasswordError,
	IdentityExistsError,
} from '../types/errors.js';

// ============================================================================
// Storage Format Types
// ============================================================================

/**
 * Encrypted keypair storage format
 */
interface EncryptedKeypairStorage {
	version: 1;
	id: string;
	label?: string;
	createdAt: number;
	signingPublicKey: string;
	keyExchangePublicKey: string;
	/** base64-encoded encrypted secrets (nonce prepended) */
	encryptedSecrets: string;
	/** base64-encoded salt for key derivation */
	salt: string;
}

/**
 * Decrypted secrets structure
 */
interface DecryptedSecrets {
	signingSecretKey: string;
	keyExchangePrivateKey: string;
}

// ============================================================================
// Directory Paths
// ============================================================================

/**
 * Get the identity directory path
 *
 * @returns Path to ~/gitspace/.identity/
 */
export function getIdentityDir(): string {
	return join(getSpacesDir(), '.identity');
}

/**
 * Get the keypair file path
 *
 * @returns Path to keypair.json
 */
export function getKeypairPath(): string {
	return join(getIdentityDir(), 'keypair.json');
}

/**
 * Get the access list file path
 *
 * @returns Path to access-list.json
 */
export function getAccessListPath(): string {
	return join(getIdentityDir(), 'access-list.json');
}

/**
 * Get the machine identity file path
 *
 * @returns Path to machine.json
 */
export function getMachineIdentityPath(): string {
	return join(getIdentityDir(), 'machine.json');
}

/**
 * Ensure identity directory exists
 */
function ensureIdentityDir(): void {
	const identityDir = getIdentityDir();
	if (!existsSync(identityDir)) {
		mkdirSync(identityDir, { recursive: true, mode: 0o700 });
	}
}

// ============================================================================
// Keypair Management
// ============================================================================

/**
 * Generate a new identity and save it to disk (encrypted)
 *
 * Creates a new Ed25519 + X25519 keypair, encrypts the secret keys with
 * a password-derived key, and saves to keypair.json.
 *
 * @param password - Password to encrypt the keypair
 * @param label - Optional human-readable label
 * @param force - If true, overwrite existing keypair
 * @returns Public identity information
 * @throws {IdentityExistsError} If keypair exists and force is false
 */
export async function generateAndSaveKeypair(
	password: string,
	label?: string,
	force: boolean = false
): Promise<PublicIdentity> {
	// Check if keypair already exists
	if (keypairExists() && !force) {
		throw new IdentityExistsError();
	}

	ensureIdentityDir();

	// Generate new identity
	const identity = generateIdentity(label);

	// Serialize identity to get base64 strings
	const serialized = serializeIdentity(identity);

	// Create secrets object to encrypt
	const secrets: DecryptedSecrets = {
		signingSecretKey: serialized.signingSecretKey,
		keyExchangePrivateKey: serialized.keyExchangePrivateKey,
	};

	// Generate salt and derive encryption key from password
	const salt = generateSalt();
	const encryptionKey = await deriveKey(password, salt);

	// Encrypt secrets
	const secretsJson = JSON.stringify(secrets);
	const encryptedSecrets = seal(Buffer.from(secretsJson, 'utf-8'), encryptionKey);

	// Create storage format
	const storage: EncryptedKeypairStorage = {
		version: 1,
		id: identity.id,
		label: identity.label,
		createdAt: identity.createdAt,
		signingPublicKey: serialized.signingPublicKey,
		keyExchangePublicKey: serialized.keyExchangePublicKey,
		encryptedSecrets: encryptedSecrets.toString('base64'),
		salt: salt.toString('base64'),
	};

	// Write to disk
	try {
		writeFileSync(getKeypairPath(), JSON.stringify(storage, null, 2), {
			encoding: 'utf-8',
			mode: 0o600, // Owner read/write only
		});
	} catch (error) {
		throw new SpacesError(
			`Failed to save keypair: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}

	return getPublicIdentity(identity);
}

/**
 * Load and decrypt the keypair from disk
 *
 * Reads the encrypted keypair, derives the decryption key from the password,
 * and returns the full identity with secret keys.
 *
 * @param password - Password to decrypt the keypair
 * @returns Complete identity with secret keys
 * @throws {NoIdentityError} If keypair doesn't exist
 * @throws {InvalidPasswordError} If password is incorrect
 */
export async function loadKeypair(password: string): Promise<Identity> {
	if (!keypairExists()) {
		throw new NoIdentityError();
	}

	// Read storage file
	let storage: EncryptedKeypairStorage;
	try {
		const content = readFileSync(getKeypairPath(), 'utf-8');
		storage = JSON.parse(content) as EncryptedKeypairStorage;
	} catch (error) {
		throw new SpacesError(
			`Failed to read keypair: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}

	// Derive decryption key from password
	const salt = Buffer.from(storage.salt, 'base64');
	const decryptionKey = await deriveKey(password, salt);

	// Decrypt secrets
	const encryptedSecrets = Buffer.from(storage.encryptedSecrets, 'base64');
	const decryptedSecretsBuffer = open(encryptedSecrets, decryptionKey);

	if (!decryptedSecretsBuffer) {
		throw new InvalidPasswordError();
	}

	// Parse secrets
	let secrets: DecryptedSecrets;
	try {
		secrets = JSON.parse(decryptedSecretsBuffer.toString('utf-8')) as DecryptedSecrets;
	} catch (error) {
		throw new SpacesError(
			'Failed to parse decrypted secrets',
			'SYSTEM_ERROR',
			2
		);
	}

	// Reconstruct stored identity format
	const storedIdentity = {
		id: storage.id,
		label: storage.label,
		createdAt: storage.createdAt,
		signingPublicKey: storage.signingPublicKey,
		keyExchangePublicKey: storage.keyExchangePublicKey,
		signingSecretKey: secrets.signingSecretKey,
		keyExchangePrivateKey: secrets.keyExchangePrivateKey,
	};

	// Deserialize to Identity format
	return deserializeIdentity(storedIdentity);
}

/**
 * Check if a keypair exists on disk
 *
 * @returns True if keypair.json exists
 */
export function keypairExists(): boolean {
	return existsSync(getKeypairPath());
}

/**
 * Get the public identity without requiring password
 *
 * Reads only the public keys from the stored keypair file.
 * This is safe to call without authentication.
 *
 * @returns Public identity if keypair exists, null otherwise
 */
export function getPublicKeyWithoutPassword(): PublicIdentity | null {
	if (!keypairExists()) {
		return null;
	}

	try {
		const content = readFileSync(getKeypairPath(), 'utf-8');
		const storage = JSON.parse(content) as EncryptedKeypairStorage;

		return {
			id: storage.id,
			signingPublicKey: storage.signingPublicKey,
			keyExchangePublicKey: storage.keyExchangePublicKey,
			label: storage.label,
		};
	} catch (error) {
		throw new SpacesError(
			`Failed to read public key: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}
}

// ============================================================================
// Access List Management
// ============================================================================

/**
 * Read the access list from disk
 *
 * Returns an empty array if the file doesn't exist.
 *
 * @returns Array of access entries
 */
export function readAccessList(): AccessEntry[] {
	const accessListPath = getAccessListPath();

	if (!existsSync(accessListPath)) {
		return [];
	}

	try {
		const content = readFileSync(accessListPath, 'utf-8');
		return JSON.parse(content) as AccessEntry[];
	} catch (error) {
		throw new SpacesError(
			`Failed to read access list: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}
}

/**
 * Write the access list to disk
 *
 * Creates the identity directory if it doesn't exist.
 *
 * @param entries - Array of access entries to write
 */
export function writeAccessList(entries: AccessEntry[]): void {
	ensureIdentityDir();

	try {
		writeFileSync(
			getAccessListPath(),
			JSON.stringify(entries, null, 2),
			{
				encoding: 'utf-8',
				mode: 0o600, // Owner read/write only
			}
		);
	} catch (error) {
		throw new SpacesError(
			`Failed to write access list: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}
}

/**
 * Add a new identity to the access list
 *
 * Creates a new access entry with the given access type.
 * If the identity already exists, it will be replaced.
 *
 * @param publicIdentity - Public identity to add
 * @param label - Optional label override (uses identity.label if not provided)
 * @param accessType - Access type to grant (defaults to 'full')
 * @param sessionId - Optional session ID for session-invite access
 * @returns The created access entry
 */
export function addAccess(
	publicIdentity: PublicIdentity,
	label?: string,
	accessType: AccessType = DEFAULT_ACCESS_TYPE,
	sessionId?: string
): AccessEntry {
	const entries = readAccessList();

	// Create new entry
	const newEntry: AccessEntry = {
		identityId: publicIdentity.id,
		signingPublicKey: publicIdentity.signingPublicKey,
		keyExchangePublicKey: publicIdentity.keyExchangePublicKey,
		label: label || publicIdentity.label,
		grantedAt: Date.now(),
		accessType,
		sessionId,
	};

	// Remove existing entry with same ID (if any)
	const filteredEntries = entries.filter(
		(e) => e.identityId !== publicIdentity.id
	);

	// Add new entry
	filteredEntries.push(newEntry);

	// Write back to disk
	writeAccessList(filteredEntries);

	return newEntry;
}

/**
 * Remove an identity from the access list
 *
 * Searches by identity ID or label (case-insensitive).
 *
 * @param identityIdOrLabel - Identity ID or label to remove
 * @returns True if an entry was removed, false if not found
 */
export function removeAccess(identityIdOrLabel: string): boolean {
	const entries = readAccessList();
	const searchLower = identityIdOrLabel.toLowerCase();

	const filteredEntries = entries.filter((e) => {
		const matchesId = e.identityId.toLowerCase() === searchLower;
		const matchesLabel = e.label?.toLowerCase() === searchLower;
		return !matchesId && !matchesLabel;
	});

	// Check if anything was removed
	if (filteredEntries.length === entries.length) {
		return false;
	}

	writeAccessList(filteredEntries);
	return true;
}

/**
 * Get an access entry by identity ID or label
 *
 * Searches by identity ID or label (case-insensitive).
 *
 * @param identityIdOrLabel - Identity ID or label to search for
 * @returns Access entry if found, undefined otherwise
 */
export function getAccessEntry(identityIdOrLabel: string): AccessEntry | undefined {
	const entries = readAccessList();
	const searchLower = identityIdOrLabel.toLowerCase();

	return entries.find((e) => {
		const matchesId = e.identityId.toLowerCase() === searchLower;
		const matchesLabel = e.label?.toLowerCase() === searchLower;
		return matchesId || matchesLabel;
	});
}

// ============================================================================
// Machine Identity Management
// ============================================================================

/**
 * Read machine identity configuration from disk
 *
 * @returns Machine identity if exists, null otherwise
 */
export function readMachineIdentity(): MachineIdentity | null {
	const machineIdentityPath = getMachineIdentityPath();

	if (!existsSync(machineIdentityPath)) {
		return null;
	}

	try {
		const content = readFileSync(machineIdentityPath, 'utf-8');
		return JSON.parse(content) as MachineIdentity;
	} catch (error) {
		throw new SpacesError(
			`Failed to read machine identity: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}
}

/**
 * Write machine identity configuration to disk
 *
 * Creates the identity directory if it doesn't exist.
 *
 * @param identity - Machine identity to write
 */
export function writeMachineIdentity(identity: MachineIdentity): void {
	ensureIdentityDir();

	try {
		writeFileSync(
			getMachineIdentityPath(),
			JSON.stringify(identity, null, 2),
			{
				encoding: 'utf-8',
				mode: 0o600, // Owner read/write only
			}
		);
	} catch (error) {
		throw new SpacesError(
			`Failed to write machine identity: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}
}

// ============================================================================
// Relay Configuration Management
// ============================================================================

/**
 * Relay configuration for coordination between serve/share/access commands
 *
 * Note: Authentication is now done via challenge-response (no JWT tokens)
 */
export interface RelayConfig {
	/** Relay WebSocket URL */
	relayUrl: string;
	/** Machine ID registered with relay */
	machineId: string;
	/** When this config was saved */
	savedAt: number;
}

/**
 * Get the relay config file path
 *
 * @returns Path to relay.json
 */
export function getRelayConfigPath(): string {
	return join(getIdentityDir(), 'relay.json');
}

/**
 * Read relay configuration from disk
 *
 * @returns Relay config if exists, null otherwise
 */
export function readRelayConfig(): RelayConfig | null {
	const relayConfigPath = getRelayConfigPath();

	if (!existsSync(relayConfigPath)) {
		return null;
	}

	try {
		const content = readFileSync(relayConfigPath, 'utf-8');
		return JSON.parse(content) as RelayConfig;
	} catch (error) {
		throw new SpacesError(
			`Failed to read relay config: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}
}

/**
 * Write relay configuration to disk
 *
 * Creates the identity directory if it doesn't exist.
 *
 * @param config - Relay configuration to write
 */
export function writeRelayConfig(config: RelayConfig): void {
	ensureIdentityDir();

	try {
		writeFileSync(
			getRelayConfigPath(),
			JSON.stringify(config, null, 2),
			{
				encoding: 'utf-8',
				mode: 0o600, // Owner read/write only
			}
		);
	} catch (error) {
		throw new SpacesError(
			`Failed to write relay config: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}
}

/**
 * Clear relay configuration
 *
 * Removes the relay config file if it exists.
 */
export function clearRelayConfig(): void {
	const relayConfigPath = getRelayConfigPath();

	if (existsSync(relayConfigPath)) {
		try {
			const { unlinkSync } = require('node:fs');
			unlinkSync(relayConfigPath);
		} catch (error) {
			// Ignore errors when clearing
		}
	}
}
