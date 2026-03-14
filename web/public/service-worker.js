const AGENT_UI_PREFIX = '/agent-ui/'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) {
    return
  }

  const context = resolveAgentContext(event.request)
  if (!context) {
    return
  }

  event.respondWith(handleAgentRequest(event.request, context))
})

function resolveAgentContext(request) {
  const url = new URL(request.url)
  if (url.pathname.startsWith(AGENT_UI_PREFIX)) {
    const segments = url.pathname.slice(AGENT_UI_PREFIX.length).split('/')
    if (segments.length < 3) {
      return null
    }
    const [machineId, workspaceId, ...rest] = segments
    const upstreamPath = `/${rest.join('/')}`
    return {
      machineId: decodeURIComponent(machineId),
      workspaceId: decodeURIComponent(workspaceId),
      path: upstreamPath === '/' ? '/' : upstreamPath,
      query: Object.fromEntries(url.searchParams.entries()),
      isStream: request.headers.get('accept')?.includes('text/event-stream') || upstreamPath.endsWith('/event'),
    }
  }

  if (!request.referrer) {
    return null
  }

  try {
    const referrer = new URL(request.referrer)
    if (!referrer.pathname.startsWith(AGENT_UI_PREFIX)) {
      return null
    }
    const refSegments = referrer.pathname.slice(AGENT_UI_PREFIX.length).split('/')
    if (refSegments.length < 3) {
      return null
    }
    const [machineId, workspaceId] = refSegments
    return {
      machineId: decodeURIComponent(machineId),
      workspaceId: decodeURIComponent(workspaceId),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      isStream: request.headers.get('accept')?.includes('text/event-stream') || url.pathname.endsWith('/event'),
    }
  } catch {
    return null
  }
}

async function pickClient() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return clients.find((client) => client.visibilityState === 'visible') || clients[0] || null
}

async function proxyViaPage(payload) {
  const client = await pickClient()
  if (!client) {
    return { ok: false, status: 503, error: 'No active GitSpace web client available' }
  }

  const channel = new MessageChannel()
  const responsePromise = new Promise((resolve, reject) => {
    channel.port1.onmessage = (event) => resolve(event.data)
    channel.port1.onmessageerror = () => reject(new Error('Message channel error'))
  })

  client.postMessage(payload, [channel.port2])
  return responsePromise
}

async function handleAgentRequest(request, context) {
  const headers = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  if (context.isStream) {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        const client = await pickClient()
        if (!client) {
          controller.close()
          return
        }

        const channel = new MessageChannel()
        let unsubscribe = false

        channel.port1.onmessage = (event) => {
          const data = event.data
          if (!data || typeof data !== 'object') {
            return
          }
          if (data.type === 'stream-open') {
            return
          }
          if (data.type === 'stream-event') {
            const lines = []
            if (data.id) lines.push(`id: ${data.id}`)
            if (data.event) lines.push(`event: ${data.event}`)
            for (const line of String(data.data ?? '').split('\n')) {
              lines.push(`data: ${line}`)
            }
            lines.push('')
            controller.enqueue(encoder.encode(`${lines.join('\n')}\n`))
            return
          }
          if (data.type === 'stream-error') {
            controller.error(new Error(data.message || 'Agent stream failed'))
            return
          }
          if (data.type === 'stream-close') {
            controller.close()
          }
        }

        client.postMessage({
          type: 'gitspace-agent-proxy-request',
          mode: 'stream',
          machineId: context.machineId,
          workspaceId: context.workspaceId,
          path: context.path,
          query: context.query,
          headers,
        }, [channel.port2])

        this.cancel = () => {
          if (unsubscribe) return
          unsubscribe = true
          channel.port1.postMessage({ type: 'stream-close' })
        }
      },
      cancel() {
        if (typeof this.cancel === 'function') {
          this.cancel()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }

  const bodyBuffer = request.method === 'GET' || request.method === 'HEAD'
    ? null
    : await request.arrayBuffer()

  const proxyResponse = await proxyViaPage({
    type: 'gitspace-agent-proxy-request',
    mode: 'request',
    machineId: context.machineId,
    workspaceId: context.workspaceId,
    method: request.method,
    path: context.path,
    query: context.query,
    headers,
    bodyBase64: bodyBuffer ? arrayBufferToBase64(bodyBuffer) : undefined,
  })

  if (!proxyResponse || proxyResponse.ok === false) {
    return new Response(proxyResponse?.error || 'Agent proxy unavailable', {
      status: proxyResponse?.status || 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const responseHeaders = new Headers(proxyResponse.headers || {})
  return new Response(proxyResponse.bodyBase64 ? base64ToUint8Array(proxyResponse.bodyBase64) : null, {
    status: proxyResponse.status || 200,
    headers: responseHeaders,
  })
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToUint8Array(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
