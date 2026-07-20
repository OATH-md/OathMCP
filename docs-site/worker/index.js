const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
};

function withSecurityHeaders(response) {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
  }
  return secured;
}

export async function handleRequest(request, assets) {
  const url = new URL(request.url);

  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return withSecurityHeaders(new Response(null, {
      status: 308,
      headers: { Location: url.toString() },
    }));
  }

  return withSecurityHeaders(await assets.fetch(request));
}

export default {
  fetch(request, env) {
    return handleRequest(request, env.ASSETS);
  },
};
