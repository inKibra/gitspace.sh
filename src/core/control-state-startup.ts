import { computeIdentityId } from '../relay/identity.js';
import {
  peekPersistedOwnerBinding,
  readControlMeta,
  type PersistedOwnerBinding,
} from '../relay/control/store.js';
import type { ControlMeta } from '../relay/control/types.js';

export interface StartupCurrentRelayBinding {
  publicKey: string;
  fingerprint: string;
}

export interface StartupControlStatePlan {
  ownerUserRootId: string;
  ownerBinding: PersistedOwnerBinding;
  controlMeta: ControlMeta;
  currentRelay?: StartupCurrentRelayBinding;
  currentRelayIdentityId?: string;
  hasPinnedRelayIdentity: boolean;
  relayMismatch: boolean;
  repairableOwnerMismatch: boolean;
  hasUnrepairableOwnerMismatch: boolean;
  needsTakeover: boolean;
}

export interface StartupControlStateTextOptions {
  takeoverCommand: string;
  subject: 'machine serve' | 'relay';
}

export function planStartupControlState(input: {
  ownerUserRootId: string;
  currentRelay?: StartupCurrentRelayBinding;
}): StartupControlStatePlan {
  const ownerBinding = peekPersistedOwnerBinding();
  const controlMeta = readControlMeta();
  const hasPinnedRelayIdentity = Boolean(
    controlMeta.relayIdentityId || controlMeta.relaySigningPublicKey || controlMeta.relayFingerprint,
  );
  const currentRelayIdentityId = input.currentRelay
    ? computeIdentityId(input.currentRelay.publicKey)
    : undefined;
  const relayMismatch = Boolean(
    input.currentRelay
      && ((controlMeta.relayIdentityId && controlMeta.relayIdentityId !== currentRelayIdentityId)
        || (controlMeta.relaySigningPublicKey && controlMeta.relaySigningPublicKey !== input.currentRelay.publicKey)
        || (controlMeta.relayFingerprint && controlMeta.relayFingerprint !== input.currentRelay.fingerprint)),
  );
  const repairableOwnerMismatch = ownerBinding.mismatch
    && (ownerBinding.controlOwnerId === input.ownerUserRootId || ownerBinding.vaultOwnerId === input.ownerUserRootId);
  const hasUnrepairableOwnerMismatch = Boolean(!repairableOwnerMismatch && (
    (ownerBinding.controlOwnerId && ownerBinding.controlOwnerId !== input.ownerUserRootId)
    || (ownerBinding.vaultOwnerId && ownerBinding.vaultOwnerId !== input.ownerUserRootId)
  ));

  return {
    ownerUserRootId: input.ownerUserRootId,
    ownerBinding,
    controlMeta,
    currentRelay: input.currentRelay,
    currentRelayIdentityId,
    hasPinnedRelayIdentity,
    relayMismatch,
    repairableOwnerMismatch,
    hasUnrepairableOwnerMismatch,
    needsTakeover: hasUnrepairableOwnerMismatch || relayMismatch,
  };
}

export function formatStartupControlStateMismatch(
  plan: StartupControlStatePlan,
  options: StartupControlStateTextOptions,
): string {
  if (plan.relayMismatch && !plan.hasUnrepairableOwnerMismatch) {
    return [
      'Persisted local control bindings are pinned to a different relay.',
      '',
      `  Current user: ${plan.ownerUserRootId.slice(0, 8)}...`,
      `  Pinned relay:  ${plan.controlMeta.relayFingerprint ?? plan.controlMeta.relayIdentityId}`,
      `  Current relay: ${plan.currentRelay?.fingerprint}`,
      '',
      `Re-run with \`${options.takeoverCommand}\` to clear the persisted relay pin and rebind local control bindings to the current relay.`,
    ].join('\n');
  }

  const lines = [
    'Persisted local control bindings do not match the current identity.',
    '',
    `  Current user: ${plan.ownerUserRootId.slice(0, 8)}...`,
    plan.ownerBinding.controlOwnerId ? `  Control owner: ${plan.ownerBinding.controlOwnerId.slice(0, 8)}...` : null,
    plan.ownerBinding.vaultOwnerId ? `  Vault owner:   ${plan.ownerBinding.vaultOwnerId.slice(0, 8)}...` : null,
    plan.relayMismatch ? `  Pinned relay:  ${plan.controlMeta.relayFingerprint ?? plan.controlMeta.relayIdentityId}` : null,
    plan.relayMismatch ? `  Current relay: ${plan.currentRelay?.fingerprint}` : null,
    '',
    options.subject === 'relay'
      ? `Recover the original identity, or re-run with \`${options.takeoverCommand}\` to clear persisted local control bindings and rebind ownership.`
      : `Re-run with \`${options.takeoverCommand}\` to clear the persisted local control bindings and bind them to the recovered identity.`,
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}

export function formatStartupControlStateTakeoverPrompt(
  plan: StartupControlStatePlan,
  options: StartupControlStateTextOptions,
): string {
  if (plan.relayMismatch && !plan.hasUnrepairableOwnerMismatch) {
    if (options.subject === 'machine serve') {
      return 'Persisted local control bindings are pinned to a different relay. Clear the relay pin and rebind machine serve to the current relay?';
    }

    return 'Persisted local control bindings are pinned to a different relay. Clear the relay pin and rebind the relay startup state?';
  }

  if (plan.needsTakeover) {
    return `Persisted local control bindings do not match the current identity. Clear them and rebind this ${options.subject === 'relay' ? 'relay' : 'machine'} to the recovered identity?`;
  }

  if (plan.hasPinnedRelayIdentity) {
    if (options.subject === 'machine serve') {
      return 'Clear persisted local control bindings and relay identity pins before starting machine serve?';
    }

    return 'Clear persisted local control bindings before starting the relay?';
  }

  return `Clear persisted local control bindings before starting ${options.subject}?`;
}

export function formatStartupControlStateTakeoverWarning(
  plan: StartupControlStatePlan,
  options: StartupControlStateTextOptions,
): string {
  if (plan.relayMismatch && !plan.hasUnrepairableOwnerMismatch) {
    if (options.subject === 'machine serve') {
      return 'Clearing persisted relay pin and rebinding machine serve to the current relay.';
    }

    return 'Clearing persisted relay pin and rebinding relay startup state to the current relay.';
  }

  if (plan.needsTakeover) {
    return `Clearing persisted local control bindings and rebinding ${options.subject} ownership to the current identity.`;
  }

  if (plan.hasPinnedRelayIdentity && options.subject === 'machine serve') {
    return 'Clearing persisted local control bindings and relay identity pins before machine serve startup.';
  }

  return `Clearing persisted local control bindings before ${options.subject} startup.`;
}
