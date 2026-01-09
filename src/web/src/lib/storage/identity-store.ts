/**
 * IndexedDB storage for client identity
 */

import type { Identity, StoredIdentity } from "../../types/identity";
import { generateIdentity, serializeIdentity, deserializeIdentity } from "../crypto/identity";

const DB_NAME = "spaces-terminal";
const STORE_NAME = "identity";
const IDENTITY_KEY = "client-identity";

/**
 * Open IndexedDB database
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

/**
 * Get stored identity from IndexedDB
 */
async function getStoredIdentity(): Promise<StoredIdentity | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(IDENTITY_KEY);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

/**
 * Store identity in IndexedDB
 */
async function storeIdentity(identity: StoredIdentity): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(identity, IDENTITY_KEY);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * Get or create client identity
 */
export async function getOrCreateIdentity(): Promise<Identity> {
  const stored = await getStoredIdentity();

  if (stored) {
    return deserializeIdentity(stored);
  }

  // Generate new identity
  const identity = generateIdentity("Browser Client");
  await storeIdentity(serializeIdentity(identity));

  return identity;
}

/**
 * Clear stored identity (for logout)
 */
export async function clearIdentity(): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(IDENTITY_KEY);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}
