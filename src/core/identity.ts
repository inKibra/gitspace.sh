/**
 * Identity file operations for managing keypairs, machine identity, and relay config.
 *
 * This module handles persistent storage of cryptographic identities:
 * - Encrypted keypair storage (password-protected)
 * - Machine identity configuration
 *
 * Directory structure:
 *   ~/gitspace/.identity/
 *   ├── keypair.json      # Encrypted identity keypair
 *   └── machine.json      # Machine registration info
 *
 * @module identity
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
	Identity,
	PublicIdentity,
	MachineIdentity,
} from '../types/identity.js';
import {
	generateIdentity,
	serializeIdentity,
	deserializeIdentity,
	getPublicIdentity,
} from '../lib/tmux-lite/crypto/identity.js';
import { seal, open } from '../lib/tmux-lite/crypto/secretbox.js';
import { deriveKey, generateSalt } from '../lib/tmux-lite/crypto/keys.js';
import { getSpacesDir } from './config.js';
import {
	localSecureStoreExists,
	markLegacyLocalStorageMigrated,
	readLocalStoreJson,
	readLocalStoreSecretJson,
	unlockLocalSecureStore,
	writeLocalStoreJson,
	writeLocalStoreSecretJson,
	deleteLocalStoreJson,
} from './local-secure-store.js';
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

interface StoredDeviceIdentityPublic {
	id: string;
	label?: string;
	createdAt: number;
	signingPublicKey: string;
	keyExchangePublicKey: string;
}

const LOCAL_STORE_NAMESPACE_IDENTITY = 'identity';
const LOCAL_STORE_KEY_DEVICE_PUBLIC = 'device-public';
const LOCAL_STORE_KEY_DEVICE_SECRETS = 'device-secrets';
const LOCAL_STORE_KEY_MACHINE_IDENTITY = 'machine-identity';
const LOCAL_STORE_KEY_RELAY_CONFIG = 'relay-config';

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

function readStoredDeviceIdentityPublic(): StoredDeviceIdentityPublic | null {
	return readLocalStoreJson<StoredDeviceIdentityPublic>(
		LOCAL_STORE_NAMESPACE_IDENTITY,
		LOCAL_STORE_KEY_DEVICE_PUBLIC,
	) ?? null;
}

function writeStoredDeviceIdentityPublic(value: StoredDeviceIdentityPublic): void {
	writeLocalStoreJson(LOCAL_STORE_NAMESPACE_IDENTITY, LOCAL_STORE_KEY_DEVICE_PUBLIC, value);
}

function readStoredDeviceIdentitySecrets(): DecryptedSecrets | null {
	return readLocalStoreSecretJson<DecryptedSecrets>(
		LOCAL_STORE_NAMESPACE_IDENTITY,
		LOCAL_STORE_KEY_DEVICE_SECRETS,
	) ?? null;
}

function writeStoredDeviceIdentitySecrets(value: DecryptedSecrets): void {
	writeLocalStoreSecretJson(LOCAL_STORE_NAMESPACE_IDENTITY, LOCAL_STORE_KEY_DEVICE_SECRETS, value);
}

function migrateLegacyKeypairToLocalStore(storage: EncryptedKeypairStorage, secrets: DecryptedSecrets): void {
	writeStoredDeviceIdentityPublic({
		id: storage.id,
		label: storage.label,
		createdAt: storage.createdAt,
		signingPublicKey: storage.signingPublicKey,
		keyExchangePublicKey: storage.keyExchangePublicKey,
	});
	writeStoredDeviceIdentitySecrets(secrets);
	markLegacyLocalStorageMigrated(true);
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

	await unlockLocalSecureStore(password);
	writeStoredDeviceIdentityPublic({
		id: identity.id,
		label: identity.label,
		createdAt: identity.createdAt,
		signingPublicKey: serialized.signingPublicKey,
		keyExchangePublicKey: serialized.keyExchangePublicKey,
	});
	writeStoredDeviceIdentitySecrets(secrets);

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

	const hasInitializedLocalStore = localSecureStoreExists();
	if (hasInitializedLocalStore) {
		await unlockLocalSecureStore(password);
		const storedPublic = readStoredDeviceIdentityPublic();
		const storedSecrets = readStoredDeviceIdentitySecrets();
		if (storedPublic && storedSecrets) {
			return deserializeIdentity({
				id: storedPublic.id,
				label: storedPublic.label,
				createdAt: storedPublic.createdAt,
				signingPublicKey: storedPublic.signingPublicKey,
				keyExchangePublicKey: storedPublic.keyExchangePublicKey,
				signingSecretKey: storedSecrets.signingSecretKey,
				keyExchangePrivateKey: storedSecrets.keyExchangePrivateKey,
			});
		}
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

	if (!hasInitializedLocalStore) {
		await unlockLocalSecureStore(password);
	}

	// Deserialize to Identity format
	migrateLegacyKeypairToLocalStore(storage, secrets);
	return deserializeIdentity(storedIdentity);
}

/**
 * Check if a keypair exists on disk
 *
 * @returns True if keypair.json exists
 */
export function keypairExists(): boolean {
	return readStoredDeviceIdentityPublic() !== null || existsSync(getKeypairPath());
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
	const storedPublic = readStoredDeviceIdentityPublic();
	if (storedPublic) {
		return {
			id: storedPublic.id,
			signingPublicKey: storedPublic.signingPublicKey,
			keyExchangePublicKey: storedPublic.keyExchangePublicKey,
			label: storedPublic.label,
		};
	}

	if (!existsSync(getKeypairPath())) {
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
// Machine Identity Management
// ============================================================================

/**
 * Read machine identity configuration from disk
 *
 * @returns Machine identity if exists, null otherwise
 */
export function readMachineIdentity(): MachineIdentity | null {
	const stored = readLocalStoreJson<MachineIdentity>(
		LOCAL_STORE_NAMESPACE_IDENTITY,
		LOCAL_STORE_KEY_MACHINE_IDENTITY,
	);
	if (stored) {
		return stored;
	}

	const machineIdentityPath = getMachineIdentityPath();

	if (!existsSync(machineIdentityPath)) {
		return null;
	}

	let identity: MachineIdentity;
	try {
		const content = readFileSync(machineIdentityPath, 'utf-8');
		identity = JSON.parse(content) as MachineIdentity;
	} catch (error) {
		throw new SpacesError(
			`Failed to read machine identity: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}

	try {
		writeLocalStoreJson(LOCAL_STORE_NAMESPACE_IDENTITY, LOCAL_STORE_KEY_MACHINE_IDENTITY, identity);
		markLegacyLocalStorageMigrated(true);
	} catch {
		// Keep returning the parsed legacy value even if opportunistic migration fails.
	}

	return identity;
}

/**
 * Write machine identity configuration to disk
 *
 * Creates the identity directory if it doesn't exist.
 *
 * @param identity - Machine identity to write
 */
export function writeMachineIdentity(identity: MachineIdentity): void {
	writeLocalStoreJson(LOCAL_STORE_NAMESPACE_IDENTITY, LOCAL_STORE_KEY_MACHINE_IDENTITY, identity);
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
 * Relay configuration for coordination between serve/access/enroll commands
 *
 * Note: Authentication is now done via challenge-response (no JWT tokens)
 */
export interface RelayConfig {
	/** Relay WebSocket URL */
	relayUrl: string;
	/** Cloud-reachable/public relay URL for bootstrap/connect flows */
	cloudRelayUrl?: string;
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
	const stored = readLocalStoreJson<RelayConfig>(
		LOCAL_STORE_NAMESPACE_IDENTITY,
		LOCAL_STORE_KEY_RELAY_CONFIG,
	);
	if (stored) {
		return stored;
	}

	const relayConfigPath = getRelayConfigPath();

	if (!existsSync(relayConfigPath)) {
		return null;
	}

	let config: RelayConfig;
	try {
		const content = readFileSync(relayConfigPath, 'utf-8');
		config = JSON.parse(content) as RelayConfig;
	} catch (error) {
		throw new SpacesError(
			`Failed to read relay config: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`,
			'SYSTEM_ERROR',
			2
		);
	}

	try {
		writeLocalStoreJson(LOCAL_STORE_NAMESPACE_IDENTITY, LOCAL_STORE_KEY_RELAY_CONFIG, config);
		markLegacyLocalStorageMigrated(true);
	} catch {
		// Keep returning the parsed legacy value even if opportunistic migration fails.
	}

	return config;
}

/**
 * Write relay configuration to disk
 *
 * Creates the identity directory if it doesn't exist.
 *
 * @param config - Relay configuration to write
 */
export function writeRelayConfig(config: RelayConfig): void {
	writeLocalStoreJson(LOCAL_STORE_NAMESPACE_IDENTITY, LOCAL_STORE_KEY_RELAY_CONFIG, config);
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
	deleteLocalStoreJson(LOCAL_STORE_NAMESPACE_IDENTITY, LOCAL_STORE_KEY_RELAY_CONFIG);
	const relayConfigPath = getRelayConfigPath();

	if (existsSync(relayConfigPath)) {
		try {
			unlinkSync(relayConfigPath);
		} catch (error) {
			// Ignore errors when clearing
		}
	}
}
