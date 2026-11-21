// Builds the settings panel from SCHEMA and keeps it in sync with the settings object.

import { SCHEMA } from './presets.js';

function format(item, value) {
  const decimals = item.step >= 1 ? 0 : item.step >= 0.1 ? 1 : 2;
  return value.toFixed(decimals) + (item.unit || '');
}

// Returns refresh(): call it after settings change from outside (e.g. loading a preset).
export function buildPanel(container, settings, onChange) {
  const bindings = [];

  for (const section of SCHEMA) {
    const sec = document.createElement('div');
    sec.className = 'section';
    const h = document.createElement('h2');
    h.textContent = section.title;
    sec.append(h);

    for (const item of section.items) {
      const id = `ctl-${item.key}`;
      const wrap = document.createElement('div');
      wrap.className = 'ctl';
      const label = document.createElement('label');
      label.textContent = item.label;
      label.htmlFor = id;
      wrap.append(label);

      let input, output = null;
      if (item.type === 'select') {
        input = document.createElement('select');
        for (const [value, text] of item.options) input.append(new Option(text, value));
      } else {
        input = document.createElement('input');
        input.type = { range: 'range', color: 'color', check: 'checkbox' }[item.type];
        if (item.type === 'range') {
          input.min = item.min; input.max = item.max; input.step = item.step;
          output = document.createElement('output');
          wrap.append(output);
        } else {
          wrap.classList.add('inline');
        }
      }
      input.id = id;
      wrap.append(input);
      sec.append(wrap);

      const read = () => {
        if (item.type === 'check') return input.checked;
        if (item.type === 'range') return parseFloat(input.value);
        return input.value;
      };
      const write = () => {
        if (item.type === 'check') input.checked = settings[item.key];
        else input.value = settings[item.key];
        if (output) output.textContent = format(item, settings[item.key]);
      };
      input.addEventListener(item.type === 'range' || item.type === 'color' ? 'input' : 'change', () => {
        settings[item.key] = read();
        if (output) output.textContent = format(item, settings[item.key]);
        updateVisibility();
        onChange(item.key);
      });
      bindings.push({ item, wrap, write });
    }
    container.append(sec);
  }

  function updateVisibility() {
    for (const { item, wrap } of bindings) wrap.hidden = item.when ? !item.when(settings) : false;
  }

  function refresh() {
    for (const b of bindings) b.write();
    updateVisibility();
  }

  refresh();
  return refresh;
}
