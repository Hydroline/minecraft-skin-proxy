const IMAGE_CONTENT_TYPE = "image/png";
const SUCCESS_CACHE_CONTROL = "public, max-age=21600, s-maxage=86400";
const ERROR_CACHE_CONTROL = "no-store";
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
const UUID_PATTERN = /^[0-9a-f]{32}$/i;
const TEXTURE_ID_PATTERN = /^[0-9a-f]{64}$/i;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const HEAD_RENDER_SIZE = 180;
const HEAD_VISIBLE_ALPHA = 16;
const HEAD_VERTICAL_PADDING = 3;

const RENDER_PROFILES = {
  body: {
    mode: "fullbodyiso",
    parameters: {
      height: "432",
    },
  },
  head: {
    mode: "headiso",
    parameters: { width: "180" },
  },
  skin: {
    mode: "skin",
    parameters: {},
  },
};

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function readUint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
  );
}

function writeUint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  return concatBytes([
    writeUint32(data.length),
    typeBytes,
    data,
    writeUint32(crc32(concatBytes([typeBytes, data]))),
  ]);
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(
    new DecompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(bytes) {
  const compressor = new CompressionStream("deflate");
  const writer = compressor.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return new Uint8Array(await new Response(compressor.readable).arrayBuffer());
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }

  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

async function decodeRgbaPng(bytes) {
  if (
    bytes.length < PNG_SIGNATURE.length ||
    !PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    throw new Error("NMSR skin response was not a PNG image.");
  }

  let offset = PNG_SIGNATURE.length;
  let header;
  const idat = [];

  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error("NMSR skin PNG is truncated.");

    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") header = data;
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    offset = dataEnd + 4;
  }

  if (!header || header.length !== 13 || idat.length === 0) {
    throw new Error("NMSR skin PNG is missing required data.");
  }

  const width = readUint32(header, 0);
  const height = readUint32(header, 4);
  if (header[8] !== 8 || header[9] !== 6 || header[12] !== 0) {
    throw new Error("NMSR skin PNG uses an unsupported layout.");
  }

  const stride = width * 4;
  const compressed = await inflate(concatBytes(idat));
  if (compressed.length !== height * (stride + 1)) {
    throw new Error("NMSR skin PNG has an invalid data length.");
  }

  const image = new Uint8Array(width * height * 4);
  let inputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = compressed[inputOffset];
    inputOffset += 1;
    const rowOffset = y * stride;

    for (let x = 0; x < stride; x += 1) {
      const value = compressed[inputOffset + x];
      const left = x >= 4 ? image[rowOffset + x - 4] : 0;
      const above = y === 0 ? 0 : image[rowOffset - stride + x];
      const upperLeft = y === 0 || x < 4 ? 0 : image[rowOffset - stride + x - 4];

      if (filter === 0) image[rowOffset + x] = value;
      else if (filter === 1) image[rowOffset + x] = (value + left) & 0xff;
      else if (filter === 2) image[rowOffset + x] = (value + above) & 0xff;
      else if (filter === 3) image[rowOffset + x] = (value + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) image[rowOffset + x] = (value + paeth(left, above, upperLeft)) & 0xff;
      else throw new Error("NMSR skin PNG uses an unsupported filter.");
    }

    inputOffset += stride;
  }

  return { data: image, height, width };
}

async function encodeRgbaPng({ data, height, width }) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));

  for (let y = 0; y < height; y += 1) {
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;

  return concatBytes([
    PNG_SIGNATURE,
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", await deflate(raw)),
    createPngChunk("IEND", new Uint8Array()),
  ]);
}

async function renderAvatar(skinBytes) {
  const source = await decodeRgbaPng(skinBytes);
  if (source.width < 64 || source.height < 64) {
    throw new Error("NMSR returned a skin with unsupported dimensions.");
  }

  const output = { data: new Uint8Array(180 * 180 * 4), height: 180, width: 180 };
  for (const [sourceX, sourceY, overlay] of [[8, 8, false], [40, 8, true]]) {
    for (let y = 0; y < 180; y += 1) {
      for (let x = 0; x < 180; x += 1) {
        const pixelX = sourceX + Math.floor((x * 8) / 180);
        const pixelY = sourceY + Math.floor((y * 8) / 180);
        const sourceOffset = (pixelY * source.width + pixelX) * 4;
        const targetOffset = (y * output.width + x) * 4;
        if (overlay && source.data[sourceOffset + 3] === 0) continue;
        output.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
  }

  return encodeRgbaPng(output);
}

async function fitHeadRender(headBytes) {
  const source = await decodeRgbaPng(headBytes);
  let left = source.width;
  let top = source.height;
  let right = 0;
  let bottom = 0;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (source.data[(y * source.width + x) * 4 + 3] < HEAD_VISIBLE_ALPHA) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }

  if (left === source.width || top === source.height) {
    throw new Error("NMSR head render is fully transparent.");
  }

  const cropWidth = right - left;
  const cropHeight = bottom - top;
  const availableHeight = HEAD_RENDER_SIZE - HEAD_VERTICAL_PADDING * 2;
  const scale = Math.min(HEAD_RENDER_SIZE / cropWidth, availableHeight / cropHeight);
  const targetWidth = Math.max(1, Math.round(cropWidth * scale));
  const targetHeight = Math.max(1, Math.round(cropHeight * scale));
  const targetLeft = Math.floor((HEAD_RENDER_SIZE - targetWidth) / 2);
  const targetTop = Math.floor((HEAD_RENDER_SIZE - targetHeight) / 2);
  const output = {
    data: new Uint8Array(HEAD_RENDER_SIZE * HEAD_RENDER_SIZE * 4),
    height: HEAD_RENDER_SIZE,
    width: HEAD_RENDER_SIZE,
  };

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = top + Math.min(cropHeight - 1, Math.floor(y / scale));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = left + Math.min(cropWidth - 1, Math.floor(x / scale));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = ((targetTop + y) * output.width + targetLeft + x) * 4;
      output.data.set(source.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }

  return encodeRgbaPng(output);
}

function createHeaders() {
  return new Headers({
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": SUCCESS_CACHE_CONTROL,
    "Content-Type": IMAGE_CONTENT_TYPE,
    "X-Content-Type-Options": "nosniff",
  });
}

function createErrorResponse(status, message) {
  return new Response(message, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": ERROR_CACHE_CONTROL,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isPlayerIdentifier(value) {
  return (
    USERNAME_PATTERN.test(value) ||
    UUID_PATTERN.test(value.replaceAll("-", "")) ||
    TEXTURE_ID_PATTERN.test(value)
  );
}

function parseRoute(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const [route, player] = segments.map((segment) => decodeURIComponent(segment));
  if (!RENDER_PROFILES[route] && route !== "avatar") return null;
  if (!isPlayerIdentifier(player)) return null;
  return { player, route };
}

function getNmsrOrigin(env) {
  if (!env.NMSR_ORIGIN) throw new Error("NMSR_ORIGIN is not configured.");
  if (!env.NMSR_ORIGIN_TOKEN) {
    throw new Error("NMSR_ORIGIN_TOKEN is not configured.");
  }
  const origin = new URL(env.NMSR_ORIGIN);
  if (origin.protocol !== "https:") throw new Error("NMSR_ORIGIN must use HTTPS.");
  return origin;
}

function createNmsrUrl(origin, route, player) {
  const profile = RENDER_PROFILES[route];
  const url = new URL(`/${profile.mode}/${encodeURIComponent(player)}`, origin);
  for (const [name, value] of Object.entries(profile.parameters)) {
    url.searchParams.set(name, value);
  }
  return url;
}

async function fetchNmsr(origin, originToken, route, player) {
  const response = await fetch(createNmsrUrl(origin, route, player), {
    headers: {
      Accept: IMAGE_CONTENT_TYPE,
      "X-Hydcraft-Nmsr-Token": originToken,
    },
  });
  if (!response.ok) throw new Response(null, { status: response.status });
  return new Uint8Array(await response.arrayBuffer());
}

function cacheKeyFor(request) {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

export default {
  async fetch(request, env, context) {
    if (request.method === "OPTIONS") return new Response(null, { headers: createHeaders() });
    if (!new Set(["GET", "HEAD"]).has(request.method)) {
      return createErrorResponse(405, "Method not allowed.");
    }

    const route = parseRoute(new URL(request.url).pathname);
    if (!route) return createErrorResponse(404, "Unsupported skin route.");

    const key = cacheKeyFor(request);
    const cached = await caches.default.match(key);
    if (cached) {
      return request.method === "HEAD"
        ? new Response(null, { headers: cached.headers, status: cached.status })
        : cached;
    }

    try {
      const origin = getNmsrOrigin(env);
      const image = route.route === "avatar"
        ? await renderAvatar(await fetchNmsr(origin, env.NMSR_ORIGIN_TOKEN, "skin", route.player))
        : route.route === "head"
          ? await fitHeadRender(await fetchNmsr(origin, env.NMSR_ORIGIN_TOKEN, "head", route.player))
          : await fetchNmsr(origin, env.NMSR_ORIGIN_TOKEN, route.route, route.player);
      const response = new Response(image, { headers: createHeaders() });
      context.waitUntil(caches.default.put(key, response.clone()));
      return request.method === "HEAD"
        ? new Response(null, { headers: response.headers, status: response.status })
        : response;
    } catch (error) {
      if (error instanceof Response) {
        return createErrorResponse(error.status, `NMSR upstream returned ${error.status}.`);
      }

      return createErrorResponse(502, `NMSR upstream failure: ${error.message}`);
    }
  },
};
