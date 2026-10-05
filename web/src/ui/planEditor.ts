/** Shared theme/instance controls for cultural mixing and explicit growth phases. */
import type { ControlRegistry } from './controls';
import { CULTURE_LIST } from '../gen/urban/cultures';
import { MORPHOLOGIES } from '../gen/urban/morphology';
import type { PlanOverride, PhaseSpec, NucleusKind } from '../gen/urban/culture';
import { getCulture } from '../gen/urban/culture';

export function initPlanEditor(registry: ControlRegistry): void {
  const box = document.getElementById('cultureOverrides')!;
  const field = (label: string, id: string, items: [string, string][]): HTMLSelectElement => {
    const lab = document.createElement('label'); lab.htmlFor = id; lab.textContent = label;
    const select = document.createElement('select'); select.id = id;
    for (const [value, text] of items) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
    box.append(lab, select); return select;
  };
  const title = document.createElement('h4'); title.textContent = 'Historical mix within this settlement'; box.append(title);
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Add another culture to this settlement’s growth or neighbourhoods. For a separate village of another culture, use Add settlement and choose its Culture.'; box.append(hint);
  const secondary = field('Additional culture within this settlement', 'mixCulture', [['', 'No cultural mix'], ...CULTURE_LIST.map((c): [string, string] => [c.id, c.label])]);
  const mixMode = field('How cultures combine', 'mixMode', [['phases', 'Successive growth phases'], ['sectors', 'Neighbourhoods'], ['blend', 'Blend']]);
  const weightLabel = document.createElement('label'); weightLabel.htmlFor = 'mixWeight'; weightLabel.textContent = 'Second culture share';
  const weight = document.createElement('input'); weight.type = 'range'; weight.id = 'mixWeight'; weight.min = '0'; weight.max = '1'; weight.step = '0.05'; box.append(weightLabel, weight);
  const enabledLabel = document.createElement('label'); enabledLabel.className = 'check';
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.id = 'customPlan'; enabledLabel.append(enabled, document.createTextNode('Custom growth plan')); box.append(enabledLabel);
  const kinds: NucleusKind[] = ['market', 'forum', 'mosque', 'drum-tower', 'castle', 'temple', 'grove', 'ushnu', 'precinct', 'mortuary', 'maidan', 'mud-mosque', 'wizard-tower', 'clocktower', 'none'];
  const nucleus = field('Settlement centre', 'planNucleus', [['', 'From culture'], ...kinds.map((kind): [string, string] => [kind, kind.replaceAll('-', ' ')])]);
  const phasesBox = document.createElement('div'); box.append(phasesBox);
  const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary small'; add.textContent = '+ Add growth phase'; box.append(add);
  const fire = (): void => { box.dispatchEvent(new Event('change')); };
  let plan: PlanOverride | null = null, phases: PhaseSpec[] = [], phaseEdited = false, writtenCulture = '';
  const shapeItems = ['organic', 'rect', 'rounded-rect', 'square', 'oval', 'circle', 'terraces'];
  function render(): void {
    nucleus.disabled = !enabled.checked; add.disabled = !enabled.checked; phasesBox.hidden = !enabled.checked;
    phasesBox.textContent = '';
    phases.forEach((phase, index) => {
      const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '6px';
      const select = (items: string[], value: string, label: string, apply: (value: string) => void): HTMLSelectElement => {
        const select = document.createElement('select'); select.setAttribute('aria-label', `Phase ${index + 1} ${label}`);
        for (const item of new Set([...items, value])) { const option = document.createElement('option'); option.value = item; option.textContent = item.replaceAll('-', ' '); select.append(option); }
        select.value = value; select.addEventListener('change', () => { apply(select.value); phaseEdited = true; fire(); }); return select;
      };
      const morphology = typeof phase.morphology === 'string' ? phase.morphology : phase.morphology.base;
      row.append(select(Object.keys(MORPHOLOGIES), morphology, 'layout', (value) => { phases[index] = { ...phases[index], morphology: value }; }));
      row.append(select(shapeItems, phase.enclosure.shape, 'shape', (value) => { phases[index] = { ...phases[index], enclosure: { ...phases[index].enclosure, shape: value as PhaseSpec['enclosure']['shape'] } }; }));
      row.append(select(['auto', 'wall', 'palisade', 'hedge', 'none'], phase.enclosure.wall, 'boundary', (value) => { phases[index] = { ...phases[index], enclosure: { ...phases[index].enclosure, wall: value as PhaseSpec['enclosure']['wall'] } }; }));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary small'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove phase ${index + 1}`);
      remove.addEventListener('click', () => { phases.splice(index, 1); phaseEdited = true; render(); fire(); }); row.append(remove); phasesBox.append(row);
    });
  }
  enabled.addEventListener('change', render);
  add.addEventListener('click', () => { phases.push(structuredClone(getCulture(writtenCulture).core)); phaseEdited = true; render(); fire(); });
  registry.add({ el: box,
    read: (o) => {
      if (o.culture !== writtenCulture) {
        writtenCulture = o.culture; secondary.value = ''; enabled.checked = false; plan = null; phases = []; phaseEdited = false; nucleus.value = ''; weight.value = '0.5'; render();
      }
      const cultureMix = secondary.value ? { id: secondary.value, t: Number(weight.value), mode: mixMode.value as 'phases' | 'sectors' | 'blend' } : null;
      let next = plan ? structuredClone(plan) : {};
      if (nucleus.value) next.nucleus = { ...next.nucleus, kind: nucleus.value as NucleusKind };
      else if (next.nucleus) { delete next.nucleus.kind; if (!Object.keys(next.nucleus).length) delete next.nucleus; }
      if (phaseEdited) { if (phases.length) next.phases = structuredClone(phases); else delete next.phases; }
      return { ...o, cultureMix, plan: enabled.checked ? next : null };
    },
    write: (o) => {
      writtenCulture = o.culture; secondary.value = o.cultureMix?.id ?? ''; mixMode.value = o.cultureMix?.mode ?? 'phases'; weight.value = String(o.cultureMix?.t ?? 0.5);
      plan = o.plan ? structuredClone(o.plan) : null; phases = structuredClone(plan?.phases ?? []); phaseEdited = false; enabled.checked = !!plan; nucleus.value = plan?.nucleus?.kind ?? ''; render();
    },
  });
}
