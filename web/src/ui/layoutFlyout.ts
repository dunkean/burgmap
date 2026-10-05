/** Shared settlement controls live beside Customize rather than expanding its selected card. */
export function initLayoutFlyout(): { open(): void } {
  const app = document.getElementById('app')!;
  const panel = document.getElementById('panel')!;
  const details = document.getElementById('sec-plan') as HTMLDetailsElement;
  const trigger = details.querySelector('summary')!;
  const content = details.querySelector<HTMLElement>('.body')!;
  const heading = document.getElementById('settlementEditorHeading')!;
  const compact = window.matchMedia('(max-width: 830px)');
  const flyout = document.createElement('aside');
  flyout.id = 'layoutFlyout'; flyout.className = 'glass'; flyout.hidden = true;
  flyout.setAttribute('aria-labelledby', 'layoutFlyoutTitle');
  flyout.innerHTML = '<div class="drawer-head"><div><h2 id="layoutFlyoutTitle">Style mix, layout &amp; landmarks</h2><div id="layoutFlyoutTarget" class="hint"></div></div><button id="closeLayoutFlyout" type="button" class="secondary" aria-label="Close layout settings" title="Back to Customize (Esc)">&times;</button></div><div class="settings-content"></div><div class="settings-footer"><button type="button" class="secondary" data-back>Back</button><button type="button" data-apply>Apply &amp; generate</button></div>';
  flyout.querySelector('.settings-content')!.append(content);
  app.append(flyout);
  trigger.setAttribute('aria-controls', flyout.id);
  const context = flyout.querySelector<HTMLElement>('#layoutFlyoutTarget')!;
  const updateContext = (): void => { context.textContent = heading.textContent; };
  new MutationObserver(updateContext).observe(heading, { childList: true, characterData: true, subtree: true });
  function sync(): void {
    const visible = details.open && panel.classList.contains('open') && !document.getElementById('settlementsPane')!.hidden;
    flyout.hidden = !visible;
    trigger.setAttribute('aria-expanded', String(visible));
    app.classList.toggle('layout-overlay', visible && compact.matches);
    panel.inert = !panel.classList.contains('open') || (visible && compact.matches);
    if (visible) updateContext();
  }
  function close(): void {
    details.open = false; sync();
    if (panel.classList.contains('open')) trigger.focus();
  }
  details.addEventListener('toggle', () => {
    sync();
    if (!flyout.hidden) flyout.querySelector<HTMLButtonElement>('#closeLayoutFlyout')!.focus();
    else if (document.activeElement && flyout.contains(document.activeElement)) trigger.focus();
  });
  panel.addEventListener('toggle', () => {
    if (!panel.classList.contains('open') || document.getElementById('settlementsPane')!.hidden) details.open = false;
    sync();
  });
  compact.addEventListener('change', sync);
  flyout.querySelector('#closeLayoutFlyout')!.addEventListener('click', close);
  flyout.querySelector('[data-back]')!.addEventListener('click', close);
  flyout.querySelector('[data-apply]')!.addEventListener('click', () => document.getElementById('generateSettlements')!.click());
  return { open() { details.open = true; sync(); } };
}
