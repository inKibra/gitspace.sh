# Inference worker

Status: approved direction (2026-10-29), not built. Replaces the platform-level inference Worker shipped in `e978eceb`.

## Goal

The workspace object never holds image bytes, in any form, and model requests never carry inline images. History
holds references (`gs-image:v1:<workspace>:<size>:<w>x<h>:<sha256>`). Every model request is serialized with references
and streamed out by an inference worker that writes each image in as the request leaves. The only image budget is the
model's own (count, bytes, dimensions); GitSpace adds no cap of its own.

## Shape

```mermaid
flowchart LR
  subgraph WS["Workspace object: references only"]
    A["pi-durable harness, history"] --> B["Account choice, pins, failover, request gate,<br/>fit images to the model by reference (size, w×h)"]
  end
  B -- "attempt: model, context with references,<br/>options, resolved credential" --> IW
  subgraph IW["Inference worker: loaded per workspace, ships in the tenant release"]
    C["pi-ai providers + Claude Code shaping;<br/>own Bedrock and Cursor request code"] --> F["fetch: stream the body out,<br/>references replaced by image data"]
  end
  F -- "read image by reference" --> R["ImageReader (stateless tenant entrypoint),<br/>props: { workspaceId }"]
  R --> S[("Account storage, account key")]
  C -- "assistant events and response headers, streamed" --> B
```

- **Where it runs:** the tenant's Worker Loader (`CODEMODE_LOADER`) loads it from modules in the tenant release, named
  `inference:<workspaceId>:<release>`. Each name is its own isolate, separate from the workspace object; a release gets
  fresh code. Nothing in the platform.
- **What stays in the workspace object:** pi-durable (agent loop, history, tools, compaction), the model catalog as
  data, account choice, credential pins, failover between accounts, the request gate, durable retries, and fitting
  images to the model's limits (references carry size and dimensions, so no bytes are needed).
- **What moves to the inference worker:** everything that builds and sends one request: pi-ai providers, Claude Code
  shaping and its billing attestation, the vision fallback (a model request with images) and `generate_image` (its
  output is stored and returned as a reference).

## The attempt boundary

One model request attempt is one RPC call, `send(attempt)`, on the loaded worker's entrypoint.

- **In:** model, context (references only), stream options, the resolved credential for this attempt (the workspace
  object keeps account choice; the worker never stores credentials).
- **Out:** a `ReadableStream` of serialized pi assistant events plus the response status and headers the workspace
  reads for rate limits and usage (`attempt.observe`, `onResponse`). The workspace turns it back into pi's event stream.
- **Cancel:** an `AbortSignal` cannot cross RPC. The workspace cancels the returned stream; the worker aborts the
  provider request when its stream is cancelled.
- **Errors** come back as pi's error events, as a provider failure does today.

## Images

- **Reader:** `ImageReader`, a stateless entrypoint of the tenant script, handed to the loaded worker as
  `ctx.exports.ImageReader({ props: { workspaceId } })` in its `env`. It serves a reference only if the reference names
  that workspace, from the account's own storage with the account key. The loaded worker cannot change `props`.
- **Streaming:** the provider serializes the request with references in place; the worker's `fetch` streams the body
  out, replacing each reference as it goes (`expandedRequest`). A Claude subscription request takes two passes: hash
  the expanded body (WASM XXH64), then send it with the attestation written in at its known length. Memory stays at a
  few chunks whatever the images add up to.
- **Every provider streams.** Checked against pi-ai 1.3.0: every request implementation that sends images takes our
  `fetch` and leaves the base64 text alone (`anthropic-messages`, `openai-completions`, `openai-responses`,
  `azure-openai-responses`, `google-generative-ai`, `google-vertex`, `mistral-conversations`, `openrouter-images`,
  `pi-messages`), except:
  - **Bedrock** (`bedrock-converse-stream`) decodes images to bytes for the AWS SDK and sends through the SDK's own
    handler. We register our own Converse implementation through pi-ai's `setBedrockProviderModule` hook: JSON over our
    `fetch` with the bearer API key (vault Bedrock credentials are always keys, so the body is unsigned), images as
    base64 `bytes` strings, and a parser for AWS's binary event-stream reply. pi-ai's Bedrock models and auth stay.
  - **Cursor** is our own provider (`runtime-core/src/inference/providers/cursor*.ts`), protobuf over a framed body.
    It writes each image field with its real length (known from the reference) and a placeholder; the worker streams
    the raw bytes in. The streamer gains a raw-bytes mode beside base64; frame lengths come from the same sizes.

## Ingest (second phase)

Images also enter a workspace inline today; each path changes to upload first and hand the workspace a reference
(with size and dimensions read where the bytes are):

| Path | Change |
| --- | --- |
| Images attached to a message | The browser uploads through the existing upload link; the prompt carries references |
| Machine tool results (screenshots, reading an image file) | The machine uploads to the drive and returns a reference |
| Browser relay captures | The relay or extension uploads and returns a reference |
| Codemode scripts that need image bytes | The script's isolate reads through the `ImageReader` |

Until then a workspace object briefly holds an incoming image while it stores it; that is bounded and was not what
reset workspaces.

## Probe results (2026-10-29)

From a Durable Object in a throwaway dispatch namespace, as the workspace object will call it:

- Worker Loader: wasm passed as the tenant's compiled module works; `ImageReader({ props })` in `env` works and sees
  its props (a plain loopback stub or an `RpcTarget` in `env` is refused); events stream back; cancelling the stream
  reaches the loaded worker; separate globals per name; object 70 MB + two loaded workers 70 MB each all succeeded;
  outbound fetch works; pi-ai with all 42 providers loads cold in 104 ms (our models layer bundle: 3.3 MB).
- Real requests (our `createVaultModels` in the loaded worker): Anthropic subscription with 2 images, "Red, blue" in
  1.8 s (images read in 436 ms); with 6.4 MB of images, correct in 2.4 s, attestation accepted; cancel mid-reply ends
  the stream; another workspace's reference is refused.
- Not yet run: OpenAI and Google with images (no usable credential here; Codex device-code sign-in is disabled in
  GitSpace), Bedrock (needs an API key), Cursor (needs a credential). Note: that probe still loaded images inline in the
  worker; the build streams them as described above.

## Test matrix before cutover

Each with stored images, in tests (fake upstreams checking the exact bytes sent) and once live where credentials exist:
Anthropic subscription, Anthropic API key, OpenAI, Google, Bedrock (our Converse code), Cursor. Plus: cancel mid-request
and mid-reply; a reference from another workspace refused; an image missing or not its stated size; the vision fallback;
`generate_image` returning a reference; a request at the model's full image limit with the worker's memory measured.

## Order of work

1. **Platform ignores resource sources it does not know** (instead of refusing the release), so removing
   `inference-service` later cannot break restoring older releases.
2. **Inference worker**: the attempt boundary, the loaded worker with streaming expansion, `ImageReader`, our Bedrock
   Converse module, Cursor placeholders, vision fallback and `generate_image` in the worker.
3. **Cutover** in one release: the workspace uses the inference worker for every request; delete the platform
   `inference-service` source and `INFERENCE_SERVICE_NAME`, the deployed `gitspace-inference-rebuild-20260913` script,
   `packages/inference-worker`, the image-bytes provider list (`BYTE_IMAGE_APIS`, `storedInline`), `images.load` in the
   models layer, the stored-image caps, and the transport branch in `claudeCode`.
4. **Ingest** paths (above), then delete the remaining workspace-side image handling. The inline caps stay only for
   inline images still in older histories.

Platform cleanup (separate, per `AGENTS.md`): remove the platform's default-frontend serving (accounts adopting a
default release copy its frontend into their own storage first), move native mirroring and machine-client resolution
into the account, move the Back to stable inference check into the tenant, and delete the old single-bundle deploy path.
