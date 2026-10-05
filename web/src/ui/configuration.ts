/** The Customize drawer: a compact, non-modal panel beside the map (a bottom sheet on phones). */
export function initConfiguration(cancelPick: () => void): {
  open(tab?: string): void;
  close(): void;
  readonly isOpen: boolean;
  readonly tab: string;
  toggle(): void;
  picking(active: boolean): void;
} {
  const panel = document.getElementById('panel') as HTMLElement;
  const trigger = document.getElementById('menuBtn') as HTMLButtonElement;
  const tabs = Array.from(panel.querySelectorAll<HTMLButtonElement>('[role=tab]'));
  const panes = Array.from(panel.querySelectorAll<HTMLElement>('[role=tabpanel]'));
  let returnFocus: HTMLElement | null = null;
  let suspended = false;
  const sheet = window.matchMedia('(max-width: 640px)');
  const isOpen = (): boolean => panel.classList.contains('open');
  function select(id: string): void {
    for (const tab of tabs) {
      const active = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    for (const pane of panes) pane.hidden = pane.id !== id;
    panel.dispatchEvent(new Event('toggle'));
  }
  function open(tab?: string): void {
    if (!isOpen()) {
      returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : trigger;
      panel.classList.add('open'); panel.inert = false;
      trigger.setAttribute('aria-expanded', 'true');
      panel.dispatchEvent(new Event('toggle'));
    }
    select(tab ?? tabs.find((item) => item.getAttribute('aria-selected') === 'true')?.dataset.tab ?? 'settlementsPane');
  }
  function hide(): void {
    if (!isOpen()) return;
    panel.classList.remove('open'); panel.inert = true;
    trigger.setAttribute('aria-expanded', 'false');
    panel.dispatchEvent(new Event('toggle'));
  }
  function close(): void {
    suspended = false; cancelPick();
    const wasOpen = isOpen();
    hide();
    if (wasOpen) returnFocus?.focus();
  }
  const toggle = (): void => { if (isOpen()) close(); else open(); };
  trigger.addEventListener('click', toggle);
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
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen() || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    // Esc first cancels a placement in progress (settlementsPanel), the next one closes the drawer
    if (document.getElementById('map')!.classList.contains('picking')) return;
    event.preventDefault(); close();
  });
  document.getElementById('cancelPlacement')!.addEventListener('click', cancelPick);
  panel.inert = true;
  select('settlementsPane');
  return { open, close, toggle,
    get isOpen() { return isOpen(); },
    get tab() { return tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.tab ?? ''; },
    picking(active) {
      document.getElementById('placementPrompt')!.hidden = !active;
      // on phones the bottom sheet covers the map: it steps aside while a position is chosen, then comes back
      if (active && isOpen() && sheet.matches) { suspended = true; hide(); }
      else if (!active && suspended) {
        suspended = false; open('settlementsPane');
        document.getElementById('centerPick')?.focus();
      }
    },
  };
}
