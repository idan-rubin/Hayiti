import type { Trip } from '../domain/core.ts';
import { element as el } from './dom.ts';
import { displayTripTitle, t } from './journal-messages.ts';
import { portableDocument, shareableTrip } from '../domain/share-format.ts';
import { zipSync, strToU8 } from 'fflate';
import { enableHostedLinks } from './hosted-links.ts';
export function enableSharing(getTrip: () => Trip | null, portable: boolean, getDay: () => string, isSigned: () => boolean) {
  const dialog = el('sharing'),
    status = el('shareStatus');
  const openHosted = portable ? null : enableHostedLinks(getTrip, getDay, isSigned);
  let sourceRequest: Promise<string> | undefined, source: string, appFile: File | undefined;
  const urls = new Map<string, string>();
  async function getSource(): Promise<string> {
    const embedded = document.getElementById('hayiti-source');
    if (embedded) return JSON.parse(embedded.textContent || 'null');
    const response = await fetch('Hayiti.html');
    if (!response.ok) throw Error('download');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const packaged = doc.getElementById('hayiti-source');
    if (!packaged) throw Error('package');
    return JSON.parse(packaged.textContent || 'null');
  }
  function makeFile(name: string, route: ReturnType<typeof shareableTrip> | null) {
    const html = portableDocument(source, route);
    const bytes = zipSync({
      [name + '.html']: strToU8(html)
    });
    return new File([Uint8Array.from(bytes)], name + '.zip', {
      type: 'application/zip'
    });
  }
  function offer(kind: 'App' | 'Trip', file: File) {
    const link = el(`download${kind}`),
      send = el(`send${kind}`);
    if (urls.has(kind)) URL.revokeObjectURL(urls.get(kind)!);
    const url = URL.createObjectURL(file);
    urls.set(kind, url);
    link.href = url;
    link.download = file.name;
    const data = {
      files: [file]
    };
    send.hidden = !navigator.canShare?.(data);
    send.onclick = async () => {
      try {
        await navigator.share(data);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'AbortError') status.textContent = t('אפשר לשמור את הקובץ בכפתור ההורדה ולשלוח אותו כקובץ מצורף.');
      }
    };
  }
  function prepareTrip() {
    const trip = getTrip();
    if (!source || !trip) return;
    const copy = shareableTrip(trip, el('shareOrigin').checked);
    offer('Trip', makeFile('Hayiti-Route-' + trip.start, copy));
  }
  el('shareOrigin').onchange = prepareTrip;
  el('share').onclick = async () => {
    const trip = getTrip();
    status.textContent = '';
    el('tripChoice').hidden = !trip;
    el('shareTripTitle').textContent = trip ? displayTripTitle(trip.title) : '';
    el('shareOrigin').checked = false;
    el('originOption').hidden = !(trip?.home || trip?.homeXY || trip?.stops.some(s => s.kind === 'origin'));
    dialog.showModal();
    openHosted?.();
    try {
      sourceRequest ??= getSource();
      source = await sourceRequest;
      if (!dialog.open) return;
      appFile ??= makeFile('Hayiti', null);
      offer('App', appFile);
      prepareTrip();
    } catch {
      sourceRequest = undefined;
      status.textContent = t('הכנת הקובץ לשיתוף נכשלה. אפשר לסגור את החלון ולנסות שוב.');
    }
  };
  dialog.addEventListener('close', () => {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    el('downloadTrip').removeAttribute('href');
    if (portable) el('downloadApp').removeAttribute('href');else el('downloadApp').href = 'Hayiti.zip';
    for (const id of ['sendApp', 'sendTrip'] as const) {
      el(id).hidden = true;
      el(id).onclick = null;
    }
  });
  el('shareLink').hidden = portable;
  if (portable) el('downloadApp').removeAttribute('href');
  el('shareLink').onclick = async () => {
    const url = new URL('/', location.href).href;
    try {
      await navigator.clipboard.writeText(url);
      status.textContent = t('הקישור לאתר הועתק.');
    } catch {
      prompt(t('קישור לאתר לבעלי גישה'), url);
    }
  };
}
