/**
 * How a workspace's conversation names a stored image: `gs-image:v1:<workspace>:<size>:<width>x<height>:<sha256>`, the
 * bytes being a drive blob in the workspace's scope (`space:<workspace>`) named by their SHA-256. A client that stored
 * an image itself (the browser through an image upload link, a machine through its blob store, a browser session's
 * capture) sends this reference in place of the image's base64; the workspace admits it only once it found the blob, and
 * measures the width and height from its header itself (a client may send 0x0).
 */
const REFERENCE = /^gs-image:v1:([A-Za-z0-9._-]{1,128}):(0|[1-9][0-9]{0,11}):(0|[1-9][0-9]{0,5})x(0|[1-9][0-9]{0,5}):([a-f0-9]{64})$/u;

/** `width` and `height` are the image's as its header declared them when it was stored, 0 when it declared none: every
 * request checks them against its model's limits, as it checks an inline image's header. */
export interface ImageReference { workspaceId: string; size: number; width: number; height: number; sha256: string }

export function imageReference(image: ImageReference): string {
  return `gs-image:v1:${image.workspaceId}:${image.size}:${image.width}x${image.height}:${image.sha256}`;
}

export function parseImageReference(data: string): ImageReference | null {
  const match = REFERENCE.exec(data);
  return match ? { workspaceId: match[1]!, size: Number(match[2]), width: Number(match[3]), height: Number(match[4]), sha256: match[5]! } : null;
}
