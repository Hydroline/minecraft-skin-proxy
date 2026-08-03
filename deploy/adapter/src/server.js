import http from 'node:http'

const IMAGE_CONTENT_TYPE = 'image/png'
const SUCCESS_CACHE_CONTROL = 'public, max-age=21600, s-maxage=86400'
const ERROR_CACHE_CONTROL = 'no-store'
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/
const UUID_PATTERN = /^[0-9a-f]{32}$/i
const TEXTURE_ID_PATTERN = /^[0-9a-f]{64}$/i
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const HEAD_RENDER_SIZE = 180
const HEAD_VISIBLE_ALPHA = 16
const HEAD_VERTICAL_PADDING = 3

const RENDER_PROFILES = {
  body: { mode: 'fullbodyiso', parameters: { height: '432' } },
  head: { mode: 'headiso', parameters: { width: '180' } },
  skin: { mode: 'skin', parameters: {} },
}

const nmsrOrigin = new URL(process.env.NMSR_ORIGIN ?? 'http://nmsr:8080')
const port = Number.parseInt(process.env.PORT ?? '8080', 10)

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const output = new Uint8Array(length)
  let offset = 0

  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }

  return output
}

function readUint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

function writeUint32(value) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function crc32(bytes) {
  let crc = 0xffffffff

  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }

  return (crc ^ 0xffffffff) >>> 0
}

function createPngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type)
  return concatBytes([
    writeUint32(data.length),
    typeBytes,
    data,
    writeUint32(crc32(concatBytes([typeBytes, data]))),
  ])
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function deflate(bytes) {
  const compressor = new CompressionStream('deflate')
  const writer = compressor.writable.getWriter()
  await writer.write(bytes)
  await writer.close()
  return new Uint8Array(await new Response(compressor.readable).arrayBuffer())
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  return aboveDistance <= upperLeftDistance ? above : upperLeft
}

async function decodeRgbaPng(bytes) {
  if (bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new Error('NMSR skin response was not a PNG image.')
  }

  let offset = PNG_SIGNATURE.length
  let header
  const idat = []

  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) throw new Error('NMSR skin PNG is truncated.')

    const data = bytes.subarray(dataStart, dataEnd)
    if (type === 'IHDR') header = data
    if (type === 'IDAT') idat.push(data)
    if (type === 'IEND') break
    offset = dataEnd + 4
  }

  if (!header || header.length !== 13 || idat.length === 0) {
    throw new Error('NMSR skin PNG is missing required data.')
  }

  const width = readUint32(header, 0)
  const height = readUint32(header, 4)
  if (header[8] !== 8 || header[9] !== 6 || header[12] !== 0) {
    throw new Error('NMSR skin PNG uses an unsupported layout.')
  }

  const stride = width * 4
  const compressed = await inflate(concatBytes(idat))
  if (compressed.length !== height * (stride + 1)) {
    throw new Error('NMSR skin PNG has an invalid data length.')
  }

  const image = new Uint8Array(width * height * 4)
  let inputOffset = 0

  for (let y = 0; y < height; y += 1) {
    const filter = compressed[inputOffset]
    inputOffset += 1
    const rowOffset = y * stride

    for (let x = 0; x < stride; x += 1) {
      const value = compressed[inputOffset + x]
      const left = x >= 4 ? image[rowOffset + x - 4] : 0
      const above = y === 0 ? 0 : image[rowOffset - stride + x]
      const upperLeft = y === 0 || x < 4 ? 0 : image[rowOffset - stride + x - 4]

      if (filter === 0) image[rowOffset + x] = value
      else if (filter === 1) image[rowOffset + x] = (value + left) & 0xff
      else if (filter === 2) image[rowOffset + x] = (value + above) & 0xff
      else if (filter === 3) image[rowOffset + x] = (value + Math.floor((left + above) / 2)) & 0xff
      else if (filter === 4) image[rowOffset + x] = (value + paeth(left, above, upperLeft)) & 0xff
      else throw new Error('NMSR skin PNG uses an unsupported filter.')
    }

    inputOffset += stride
  }

  return { data: image, height, width }
}

async function encodeRgbaPng({ data, height, width }) {
  const stride = width * 4
  const raw = new Uint8Array(height * (stride + 1))

  for (let y = 0; y < height; y += 1) {
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = 6

  return concatBytes([
    PNG_SIGNATURE,
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', await deflate(raw)),
    createPngChunk('IEND', new Uint8Array()),
  ])
}

async function renderAvatar(skinBytes) {
  const source = await decodeRgbaPng(skinBytes)
  if (source.width < 64 || source.height < 64) {
    throw new Error('NMSR returned a skin with unsupported dimensions.')
  }

  const output = { data: new Uint8Array(180 * 180 * 4), height: 180, width: 180 }
  for (const [sourceX, sourceY, overlay] of [[8, 8, false], [40, 8, true]]) {
    for (let y = 0; y < 180; y += 1) {
      for (let x = 0; x < 180; x += 1) {
        const pixelX = sourceX + Math.floor((x * 8) / 180)
        const pixelY = sourceY + Math.floor((y * 8) / 180)
        const sourceOffset = (pixelY * source.width + pixelX) * 4
        const targetOffset = (y * output.width + x) * 4
        if (overlay && source.data[sourceOffset + 3] === 0) continue
        output.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), targetOffset)
      }
    }
  }

  return encodeRgbaPng(output)
}

async function fitHeadRender(headBytes) {
  const source = await decodeRgbaPng(headBytes)
  let left = source.width
  let top = source.height
  let right = 0
  let bottom = 0

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (source.data[(y * source.width + x) * 4 + 3] < HEAD_VISIBLE_ALPHA) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x + 1)
      bottom = Math.max(bottom, y + 1)
    }
  }

  if (left === source.width || top === source.height) {
    throw new Error('NMSR head render is fully transparent.')
  }

  const cropWidth = right - left
  const cropHeight = bottom - top
  const availableHeight = HEAD_RENDER_SIZE - HEAD_VERTICAL_PADDING * 2
  const scale = Math.min(HEAD_RENDER_SIZE / cropWidth, availableHeight / cropHeight)
  const targetWidth = Math.max(1, Math.round(cropWidth * scale))
  const targetHeight = Math.max(1, Math.round(cropHeight * scale))
  const targetLeft = Math.floor((HEAD_RENDER_SIZE - targetWidth) / 2)
  const targetTop = Math.floor((HEAD_RENDER_SIZE - targetHeight) / 2)
  const output = {
    data: new Uint8Array(HEAD_RENDER_SIZE * HEAD_RENDER_SIZE * 4),
    height: HEAD_RENDER_SIZE,
    width: HEAD_RENDER_SIZE,
  }

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = top + Math.min(cropHeight - 1, Math.floor(y / scale))
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = left + Math.min(cropWidth - 1, Math.floor(x / scale))
      const sourceOffset = (sourceY * source.width + sourceX) * 4
      const targetOffset = ((targetTop + y) * output.width + targetLeft + x) * 4
      output.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), targetOffset)
    }
  }

  return encodeRgbaPng(output)
}

function createImageHeaders() {
  return {
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-origin': '*',
    'access-control-max-age': '86400',
    'cache-control': SUCCESS_CACHE_CONTROL,
    'content-type': IMAGE_CONTENT_TYPE,
    'x-content-type-options': 'nosniff',
  }
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, headers)
  response.end(body)
}

function sendError(response, status, message) {
  send(response, status, message, {
    'access-control-allow-origin': '*',
    'cache-control': ERROR_CACHE_CONTROL,
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
}

function isPlayerIdentifier(value) {
  const normalizedUuid = value.replaceAll('-', '')
  return USERNAME_PATTERN.test(value) || UUID_PATTERN.test(normalizedUuid) || TEXTURE_ID_PATTERN.test(value)
}

function parseRoute(pathname) {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length !== 2) return null
  const [route, player] = segments.map((segment) => decodeURIComponent(segment))
  if (!RENDER_PROFILES[route] && route !== 'avatar') return null
  if (!isPlayerIdentifier(player)) return null
  return { player, route }
}

function createNmsrUrl(route, player) {
  const profile = RENDER_PROFILES[route]
  const url = new URL(`/${profile.mode}/${encodeURIComponent(player)}`, nmsrOrigin)
  for (const [name, value] of Object.entries(profile.parameters)) url.searchParams.set(name, value)
  return url
}

async function fetchNmsr(route, player) {
  const response = await fetch(createNmsrUrl(route, player), {
    headers: { accept: IMAGE_CONTENT_TYPE },
    signal: AbortSignal.timeout(20_000),
  })

  if (!response.ok) {
    const error = new Error(`NMSR upstream returned ${response.status}.`)
    error.status = response.status
    throw error
  }

  return new Uint8Array(await response.arrayBuffer())
}

async function handleRequest(request, response) {
  if (request.method === 'OPTIONS') return send(response, 204, undefined, createImageHeaders())
  if (!new Set(['GET', 'HEAD']).has(request.method)) return sendError(response, 405, 'Method not allowed.')

  const url = new URL(request.url, 'http://adapter.internal')
  if (url.pathname === '/healthz') return send(response, 204, undefined)

  let route
  try {
    route = parseRoute(url.pathname)
  } catch {
    return sendError(response, 400, 'Malformed skin route.')
  }
  if (!route) return sendError(response, 404, 'Unsupported skin route.')

  try {
    const image = route.route === 'avatar'
      ? await renderAvatar(await fetchNmsr('skin', route.player))
      : route.route === 'head'
        ? await fitHeadRender(await fetchNmsr('head', route.player))
        : await fetchNmsr(route.route, route.player)
    return send(response, 200, request.method === 'HEAD' ? undefined : image, createImageHeaders())
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 502
    return sendError(response, status, status === 502 ? 'NMSR upstream failure.' : error.message)
  }
}

http.createServer((request, response) => {
  void handleRequest(request, response).catch(() => sendError(response, 500, 'Unexpected adapter failure.'))
}).listen(port, '0.0.0.0', () => {
  console.info(`minecraft-skin adapter listening on :${port}`)
})
