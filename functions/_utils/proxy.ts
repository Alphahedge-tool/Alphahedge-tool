type EnvLike = {
  BACKEND_ORIGIN?: string;
};

function buildTargetUrl(request: Request, backendOrigin: string) {
  const incomingUrl = new URL(request.url);
  const targetBase = new URL(backendOrigin);
  return new URL(`${incomingUrl.pathname}${incomingUrl.search}`, targetBase);
}

export async function proxyToBackend(request: Request, env: EnvLike): Promise<Response> {
  const backendOrigin = env.BACKEND_ORIGIN?.trim();

  if (!backendOrigin) {
    return new Response(
      'Missing Cloudflare Pages env var BACKEND_ORIGIN.',
      { status: 500, headers: { 'content-type': 'text/plain; charset=UTF-8' } }
    );
  }

  const targetUrl = buildTargetUrl(request, backendOrigin);
  const headers = new Headers(request.headers);
  const requestUrl = new URL(request.url);

  headers.delete('host');
  headers.set('x-forwarded-host', requestUrl.host);
  headers.set('x-forwarded-proto', requestUrl.protocol.replace(':', ''));

  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
    // Required by the runtime when forwarding a streamed request body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}
