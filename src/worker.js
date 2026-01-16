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

      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      return new Response(`Worker Internal Error: ${error.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },
};
