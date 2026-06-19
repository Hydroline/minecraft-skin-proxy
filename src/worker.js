const TARGET_BASE = "https://mc-heads.net";

const CLEAN_HEADERS = [
  "Origin",
  "Referer",
  "Sec-Fetch-Mode",
  "Sec-Fetch-Site",
  "Sec-Fetch-Dest",
  "Sec-Fetch-User",
  "CF-Connecting-IP",
  "True-Client-IP",
  "X-Real-IP",
];

const IP_CLEAN_HEADERS = [
  "X-Forwarded-For",
  "CF-Connecting-IP",
  "True-Client-IP",
];

function detectImageContentType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

export default {
  async fetch(request) {
    const { pathname, search } = new URL(request.url);
    const target = `${TARGET_BASE}${pathname}${search}`;

    const forwardedHeaders = new Headers(request.headers);

    for (const header of CLEAN_HEADERS) {
      forwardedHeaders.delete(header);
    }
    for (const header of IP_CLEAN_HEADERS) {
      forwardedHeaders.set(header, "");
    }

    forwardedHeaders.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    const hasBody = !["GET", "HEAD"].includes(request.method);

    try {
      const response = await fetch(target, {
        method: request.method,
        headers: forwardedHeaders,
        redirect: "follow",
        body: hasBody ? request.body : null,
        cf: {
          cacheEverything: true,
          cacheTtl: 86400,
        },
      });

      if (response.status >= 500) {
        const errorText = await response.text();
        return new Response(
          `Upstream Error: ${response.status} - ${errorText}`,
          {
            status: response.status,
            headers: { "Content-Type": "text/plain" },
          }
        );
      }

      const body = await response.arrayBuffer();
      const headers = new Headers(response.headers);
      const declaredContentType = headers.get("Content-Type") || "";
      const detectedContentType = detectImageContentType(new Uint8Array(body));

      if (detectedContentType && declaredContentType.startsWith("text/html")) {
        headers.set("Content-Type", detectedContentType);
      }

      return new Response(body, {
        status: response.status,
        headers,
      });
    } catch (error) {
      return new Response(`Worker Internal Error: ${error.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },
};
