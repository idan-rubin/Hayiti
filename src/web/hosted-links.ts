import type { Trip } from '../domain/core.ts';
import { element as el, errorMessage } from './dom.ts';
import { locale } from './language.ts';
import { displayTripTitle, t } from './journal-messages.ts';
const errorCopy = 'לא הצלחנו להתחבר. אפשר לנסות שוב.';
async function send(url: string, body: unknown, options: RequestInit = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    ...options
  });
  const value = await res.json();
  if (!res.ok) throw Error(value.error || errorCopy);
  return value;
}
async function manage(action: unknown) {
  const result = await send('/api/route-links', action);
  if (!result.relay) return result;
  return send(result.publisher + '/api/route-links?relay', result.relay, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer'
  });
}
const button = (label: string, click: () => void) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.onclick = click;
  return b;
};
export function enableHostedLinks(getTrip: () => Trip | null, getDay: () => string, isSigned: () => boolean) {
  const block = el('hostedLinks'),
    state = el('hostedStatus'),
    list = el('hostedList');
  const scope = el('linkScope'),
    date = el('linkDay'),
    newButton = el('newHostedLink');
  let sequence = 0,
    pendingId = '',
    latest = '';
  function reset() {
    latest = '';
    pendingId = '';
    el('createdLink').hidden = true;
    date.hidden = scope.value !== 'day';
  }
  for (const field of [scope, date, el('includeHostedOrigin'), el('linkLabel')]) field.oninput = reset;
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      state.textContent = t('הקישור הועתק.');
    } catch {
      const field = el('hostedURL');
      el('createdLink').hidden = false;
      field.value = url;
      field.focus();
      field.select();
      state.textContent = t('אפשר להעתיק את הקישור המסומן.');
    }
  }
  async function refresh(epoch: number) {
    const {
      links
    } = await manage({
      type: 'list'
    });
    if (epoch !== sequence || !el('sharing').open) return;
    list.replaceChildren();
    for (const link of links) {
      const row = document.createElement('li'),
        text = document.createElement('span');
      text.textContent = [link.label, displayTripTitle(link.title), link.scope === 'day' ? link.day : t('כל הטיול'), link.origin === 'yes' ? t('כולל נקודת יציאה') : '', new Date(link.created).toLocaleString(locale(), {
        dateStyle: 'short',
        timeStyle: 'short'
      })].filter(Boolean).join(' · ');
      const revoke = button(t('ביטול גישה'), async () => {
        if (!confirm(t('לבטל את הגישה? כל מי שקיבל את הקישור הזה יאבד גישה למסלול.'))) return;
        revoke.disabled = true;
        try {
          await manage({
            type: 'revoke',
            id: link.id
          });
          row.remove();
          if (el('hostedURL').value === link.url) reset();
          if (!list.children.length) el('linksHeading').hidden = true;
          state.textContent = t('הגישה בוטלה. הקישור אינו פעיל עוד.');
        } catch (e) {
          state.textContent = t(errorMessage(e) || errorCopy);
          revoke.disabled = false;
        }
      });
      row.append(text, button(t('העתקת קישור'), () => copy(link.url)), revoke);
      list.append(row);
    }
    el('linksHeading').hidden = !links.length;
  }
  el('sharing').addEventListener('close', () => {
    sequence++;
  });
  el('copyHosted').onclick = () => copy(el('hostedURL').value);
  el('sendHosted').onclick = async () => {
    try {
      await navigator.share({
        url: el('hostedURL').value
      });
    } catch (e) {
      if (!(e instanceof Error) || e.name !== 'AbortError') await copy(el('hostedURL').value);
    }
  };
  newButton.onclick = async () => {
    if (latest) {
      await copy(latest);
      return;
    }
    const trip = getTrip();
    if (!trip) return;
    const epoch = sequence;
    pendingId ||= crypto.randomUUID();
    const action = {
      type: 'create',
      id: pendingId,
      tripId: trip.id,
      scope: scope.value,
      day: date.value,
      includeOrigin: el('includeHostedOrigin').checked,
      label: el('linkLabel').value
    };
    newButton.disabled = true;
    el('linkOptions').disabled = true;
    state.textContent = t('יוצר קישור…');
    try {
      const {
        url
      } = await manage(action);
      if (epoch !== sequence) return;
      latest = url;
      el('hostedURL').value = url;
      el('createdLink').hidden = false;
      state.textContent = t('הקישור מוכן לשיתוף.');
      await copy(url);
      await refresh(epoch);
    } catch (e) {
      if (epoch === sequence) state.textContent = t(errorMessage(e) || errorCopy);
    } finally {
      if (epoch === sequence) {
        newButton.disabled = false;
        el('linkOptions').disabled = false;
      }
    }
  };
  return () => {
    const trip = getTrip(),
      epoch = ++sequence;
    block.hidden = false;
    reset();
    list.replaceChildren();
    state.textContent = '';
    el('linksHeading').hidden = true;
    el('hostedSignIn').hidden = isSigned();
    el('linkOptions').hidden = !isSigned() || !trip;
    newButton.hidden = !isSigned() || !trip;
    newButton.disabled = false;
    el('linkOptions').disabled = false;
    el('sendHosted').hidden = !navigator.share;
    el('includeHostedOrigin').checked = false;
    el('linkLabel').value = '';
    scope.value = 'day';
    date.hidden = false;
    date.value = getDay() || '';
    if (trip) {
      date.min = trip.start;
      date.max = trip.end;
    }
    if (isSigned()) refresh(epoch).catch(e => {
      if (epoch === sequence) state.textContent = t(errorMessage(e) || errorCopy);
    });
  };
}
