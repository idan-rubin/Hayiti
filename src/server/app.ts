import { journalAPI } from './journal-api.ts';
import { routeLinkAPI } from './route-links.ts';
import type { Bindings } from './storage.ts';

/** identity must come from the host's verified session or OAuth token. */
export async function handleRequest(request: Request, env: Bindings, identity: string | null, assets: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  switch (url.pathname) {
    case '/':
      return Response.redirect(new URL('/journal.html', url).href, 302);
    case '/Masluli.html':
      return Response.redirect(new URL('/Hayiti.html', url).href, 301);
    case '/Masluli.zip':
      return Response.redirect(new URL('/Hayiti.zip', url).href, 301);
    case '/favicon.svg':
      return Response.redirect(new URL('/hayiti-icon.png', url).href, 301);
    case '/api/journal':
      return journalAPI(request, env.BUCKET, 'web', identity);
    case '/mcp':
      return journalAPI(request, env.BUCKET, 'mcp', identity);
    case '/api/route-links':
      return routeLinkAPI(request, env, url.origin === env.PUBLISHER_ORIGIN, identity);
    default:
      return assets(request);
  }
}
