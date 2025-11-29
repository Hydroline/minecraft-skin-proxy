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

    let response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers: forwardedHeaders,
        redirect: "follow",
        body: request.body,
        cf: {
          resolveOverride: "mc-heads.net",
          colo: "SJC",
          cacheEverything: true,
          cacheTtl: 86400,
        },
      });
    } catch (error) {
      return new Response(null, { status: 204 });
    }

    if (response.status >= 500) {
      return new Response(null, { status: 204 });
    }

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
};
