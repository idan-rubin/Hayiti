import type { Bucket, Bindings } from './storage.ts';
type Action = {
  type: 'list';
} | {
  type: 'revoke';
  id: string;
} | {
  type: 'create';
  id: string;
  route: ReturnType<typeof shareableTrip>;
  scope: 'trip' | 'day';
  day: string | null;
  created: string;
  label: string;
  includeOrigin: boolean;
};
import { shareableTrip } from '../domain/share-format.ts';
import { loadState } from './storage.ts';
import { safeDate } from '../domain/core.ts';
const namespacePattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const response = (data: unknown, status = 200) => Response.json(data, {
  status,
  headers: {
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer'
  }
});
const bad = (message: string, status = 400) => response({
  error: message
}, status);
const missing = () => bad('הגישה למסלול הזה אינה זמינה.', 404);
const keyFor = (owner: string, id: string) => 'route-links/' + owner + '/' + id;
function shareURL(publisher: string, owner: string, id: string) {
  return publisher + '/journal.html#route=' + owner + '.' + id;
}
async function macKey(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), {
    name: 'HMAC',
    hash: 'SHA-256'
  }, false, ['sign', 'verify']);
}
async function sign(key: CryptoKey, value: string) {
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
async function applyAction(bucket: Bucket, owner: string, action: Action, publisher: string) {
  if (action.type === 'list') {
    const links = [];
    let cursor;
    do {
      const page = await bucket.list({
        prefix: 'route-links/' + owner + '/',
        include: ['customMetadata'],
        cursor
      });
      for (const obj of page.objects) {
        const meta = obj.customMetadata;
        if (!meta?.created) continue;
        const id = obj.key.split('/').at(-1)!;
        links.push({
          id,
          ...meta,
          created: meta.created,
          url: shareURL(publisher, owner, id)
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    links.sort((a, b) => b.created.localeCompare(a.created));
    return response({
      links
    });
  }
  if (!idPattern.test(action.id)) return bad('מזהה הקישור אינו תקין.');
  const key = keyFor(owner, action.id);
  if (action.type === 'revoke') {
    if (!(await bucket.head(key))) return missing();
    // Keeping a data-free tombstone prevents a late retry from reopening a revoked link.
    await bucket.put(key, '', {
      customMetadata: {
        revoked: '1'
      }
    });
    return response({
      revoked: true
    });
  }
  if (action.type !== 'create') return bad('פעולה לא מוכרת.');
  const meta = {
    title: action.route.title,
    scope: action.scope,
    day: action.day || '',
    created: action.created,
    label: action.label,
    origin: action.includeOrigin ? 'yes' : 'no'
  };
  const object = await bucket.put(key, JSON.stringify(action.route), {
    onlyIf: {
      etagDoesNotMatch: '*'
    },
    customMetadata: meta
  });
  if (!object) {
    const existing = await bucket.head(key);
    if (!existing?.customMetadata?.created) return bad('הקישור כבר בוטל. אפשר ליצור קישור חדש.', 409);
  }
  return response({
    url: shareURL(publisher, owner, action.id),
    id: action.id
  });
}
async function view(request: Request, bucket: Bucket) {
  const [owner, id, ...rest] = (request.headers.get('X-Hayiti-View') || '').split('.');
  if (rest.length || !namespacePattern.test(owner) || !idPattern.test(id)) return missing();
  const key = keyFor(owner, id);
  if (request.method === 'HEAD') {
    const object = await bucket.head(key);
    return object?.customMetadata?.created ? new Response(null, {
      headers: {
        'Cache-Control': 'private, no-store'
      }
    }) : missing();
  }
  const object = await bucket.get(key);
  if (!object?.customMetadata?.created) return missing();
  return new Response(await object.text(), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer'
    }
  });
}
async function ownerAction(request: Request, env: Bindings, isPublisher: boolean, user: string | null) {
  if (!user) return bad('יש להיכנס עם ChatGPT כדי לנהל קישורים.', 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return bad('מקור הבקשה אינו תואם.', 403);
  if (!env.HAYITI_SHARE_RELAY) return bad('שיתוף הקישורים אינו זמין כעת.', 503);
  const data = await request.json();
  if (!['create', 'list', 'revoke'].includes(data?.type)) return bad('פעולה לא מוכרת.');
  const key = await macKey(env.HAYITI_SHARE_RELAY);
  const owner = await sign(key, JSON.stringify(['owner', isPublisher ? 'public' : 'private', user]));
  let action: Action = {
    type: 'list'
  };
  if (data.type !== 'list') {
    if (!idPattern.test(data.id)) return bad('מזהה הקישור אינו תקין.');
    action = {
      type: 'revoke',
      id: data.id
    };
  }
  if (data.type === 'create') {
    const journal = await loadState(env.BUCKET, user);
    const trip = journal.trips.find(t => t.id === data.tripId);
    if (!trip) return bad('לא נמצא טיול שמור בחשבון הזה.', 404);
    if (!['day', 'trip'].includes(data.scope)) return bad('יש לבחור יום או טיול שלם.');
    const day = data.scope === 'day' ? data.day : null;
    if (data.scope === 'day' && (!safeDate(day) || day < trip.start || day > trip.end)) return bad('התאריך אינו בטווח הטיול.');
    const includeOrigin = data.includeOrigin === true;
    const route = shareableTrip(trip, includeOrigin, day);
    if (!route.stops.length) return bad('אין תחנות לשיתוף בטווח הזה.');
    action = {
      type: 'create',
      id: data.id,
      scope: data.scope,
      day,
      includeOrigin,
      route,
      label: String(data.label || '').trim().slice(0, 64),
      created: new Date().toISOString()
    };
  }
  if (isPublisher) return applyAction(env.BUCKET, owner, action, env.PUBLISHER_ORIGIN);
  const body = JSON.stringify({
    aud: 'hayiti-route-links-v1',
    expires: Date.now() + 120000,
    owner,
    action
  });
  return response({
    publisher: env.PUBLISHER_ORIGIN,
    relay: {
      body,
      signature: await sign(key, body)
    }
  });
}
function cors(res: Response, privateJournal?: string) {
  const headers = new Headers(res.headers);
  if (privateJournal) headers.set('Access-Control-Allow-Origin', privateJournal);
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, {
    status: res.status,
    headers
  });
}
async function relay(request: Request, env: Bindings) {
  const privateJournal = env.RELAY_ORIGIN;
  const withCors = (res: Response) => cors(res, privateJournal);
  if (!privateJournal || request.headers.get('origin') !== privateJournal) return bad('מקור הבקשה אינו תואם.', 403);
  if (request.method === 'OPTIONS') return withCors(new Response(null, {
    status: 204
  }));
  if (!env.HAYITI_SHARE_RELAY) return withCors(bad('שיתוף הקישורים אינו זמין כעת.', 503));
  const {
    body,
    signature
  } = await request.json();
  if (typeof body !== 'string' || typeof signature !== 'string' || !namespacePattern.test(signature)) return withCors(bad('חתימה חסרה.', 403));
  const key = await macKey(env.HAYITI_SHARE_RELAY);
  const bytes = Uint8Array.from(signature.match(/../g)!, s => parseInt(s, 16));
  if (!(await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(body)))) return withCors(bad('חתימה שגויה.', 403));
  const payload = JSON.parse(body);
  if (payload.aud !== 'hayiti-route-links-v1' || !Number.isFinite(payload.expires) || payload.expires < Date.now() || !namespacePattern.test(payload.owner)) return withCors(bad('פג תוקף הבקשה. אפשר לנסות שוב.', 403));
  return withCors(await applyAction(env.BUCKET, payload.owner, payload.action, env.PUBLISHER_ORIGIN));
}
export async function routeLinkAPI(request: Request, env: Bindings, isPublisher: boolean, user: string | null) {
  const relayRequest = new URL(request.url).searchParams.has('relay') && isPublisher;
  try {
    if (relayRequest && ['OPTIONS', 'POST'].includes(request.method)) return await relay(request, env);
    if (isPublisher && ['GET', 'HEAD'].includes(request.method)) return await view(request, env.BUCKET);
    if (request.method === 'POST') return await ownerAction(request, env, isPublisher, user);
    return bad('פעולה לא זמינה.', 405);
  } catch (error) {
    const res = error instanceof SyntaxError ? bad('הבקשה אינה תקינה.') : bad('אירעה תקלה. אפשר לנסות שוב.', 503);
    return relayRequest ? cors(res, env.RELAY_ORIGIN) : res;
  }
}
