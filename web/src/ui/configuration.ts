/** Native modal settings with keyboard navigation and temporary map placement. */
export function initConfiguration(cancelPick: () => void): {
  open(tab?: string): void;
  close(): void;
  picking(active: boolean): void;
} {
  const dialog = document.getElementById('panel') as HTMLDialogElement;
  const trigger = document.getElementById('menuBtn') as HTMLButtonElement;
  const tabs = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role=tab]'));
  const panes = Array.from(dialog.querySelectorAll<HTMLElement>('[role=tabpanel]'));
  const share = document.getElementById('shareControls')!;
  const quick = document.getElementById('quickShareBody')!;
  const sharePane = document.getElementById('sharePane')!;
  const messages = document.getElementById('mapMessages')!;
  const feedback = document.getElementById('settingsFeedback')!;
  const map = document.getElementById('map')!;
  let returnFocus: HTMLElement | null = null;
  let suspended = false;
  function select(id: string): void {
    for (const tab of tabs) {
      const active = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    for (const pane of panes) pane.hidden = pane.id !== id;
    if (dialog.open && id === 'sharePane') sharePane.append(share);
    else quick.append(share);
  }
  function open(tab?: string): void {
    if (!dialog.open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
      dialog.showModal(); trigger.setAttribute('aria-expanded', 'true');
    }
    feedback.append(messages);
    select(tab ?? tabs.find((item) => item.getAttribute('aria-selected') === 'true')?.dataset.tab ?? 'environmentPane');
  }
  function close(): void { suspended = false; cancelPick(); if (dialog.open) dialog.close(); }
  trigger.addEventListener('click', () => open());
  document.getElementById('closeSettings')!.addEventListener('click', close);
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab.dataset.tab!));
    tab.addEventListener('keydown', (event) => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault(); select(tabs[next].dataset.tab!); tabs[next].focus();
    });
  }
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    quick.append(share); trigger.setAttribute('aria-expanded', 'false');
    map.insertAdjacentElement('beforebegin', messages);
    if (!suspended) returnFocus?.focus();
  });
  document.getElementById('cancelPlacement')!.addEventListener('click', cancelPick);
  select('settlementsPane');
  return { open, close,
    picking(active) {
      document.getElementById('placementPrompt')!.hidden = !active;
      if (active && dialog.open) { suspended = true; dialog.close(); }
      else if (!active && suspended) {
        const originalFocus = returnFocus;
        suspended = false; open('settlementsPane'); returnFocus = originalFocus;
        document.getElementById('centerPick')?.focus();
      }
    },
  };
}
