import { element as el } from './dom.ts';
import { language } from './language.ts';

/** Asks for confirmation inside the page, so the question carries the journal's language and styling. */
export function ask(message: string, action: string): Promise<boolean> {
  const box = el('confirmBox');
  el('confirmText').textContent = message;
  el('confirmYes').textContent = action;
  el('confirmNo').textContent = language === 'he' ? 'ביטול' : 'Cancel';
  return new Promise(resolve => {
    box.returnValue = '';
    box.addEventListener('close', () => resolve(box.returnValue === 'yes'), { once: true });
    el('confirmYes').onclick = () => box.close('yes');
    el('confirmNo').onclick = () => box.close();
    box.showModal();
  });
}

export function showError(message: string, fallback: (message: string) => void) {
  const open = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]:not(#confirmBox)')].at(-1);
  if (!open) {
    fallback(message);
    return;
  }
  let note = open.querySelector<HTMLElement>('.form-error');
  if (!note) {
    note = document.createElement('p');
    note.className = 'form-error';
    note.setAttribute('role', 'alert');
    const heading = open.querySelector('.dh');
    if (heading) heading.after(note);
    else open.prepend(note);
  }
  note.textContent = message;
  note.scrollIntoView({ block: 'nearest' });
}

export function clearError(dialog: HTMLElement) {
  dialog.querySelector('.form-error')?.remove();
}
