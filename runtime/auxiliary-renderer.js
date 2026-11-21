(function installAuxiliaryChinese(kind, dictionary) {
  'use strict';
  if (!document.body) return null;

  // These are direct text children of UI-owned slots. The host prompt, password
  // field, QR payload, error details, links and app-supplied names stay opaque.
  const selectors = {
    wizard: 'title, #step-setup .text, #step-ask h1, #step-ask p, #step-ask label > span, #btn-skip',
    hud: 'title, #status, #stop, #resume, #agents .stop-agent, #agents .stopped-tag, #agents .agent .text',
    ssh: 'p.context, #title, #retry, #long, #cancel, #continue',
    disconnected: 'title, body > h1, body > p:last-of-type, .buttons > a.button',
    passkeys: 'title, .sheet-title, .mechanism-header, .mechanism-desc, .cancel-btn',
  };
  const selector = selectors[kind];
  if (!selector) return null;
  const fixedAttribute = {
    wizard: {selector:'#step-ask img[alt]', name:'alt', original:'Antigravity Icon'},
    hud: {selector:'#resume[title]', name:'title', original:'Let agents use this Mac again. The stopped task does not restart.'},
  }[kind];
  let strings = dictionary.strings || dictionary;
  const records = new Map();
  const originalLanguage = document.documentElement.getAttribute('lang');
  document.documentElement.lang = 'zh-CN';
  const exact = text => Object.hasOwn(strings, 'aux-ui:' + text) ? strings['aux-ui:' + text] : text;
  function format(key, value, original) {
    const text = exact(key);
    return text === key ? original : text.replace('{value}', () => value);
  }
  const templates = {
    hud:['AGY working in {value} (background)', '{value} AGY agents working', '{value} agents stopped'],
    ssh:['Current password for {value}', 'New password for {value}', 'Confirm new password for {value}', 'Passphrase for {value}',
      'PIN for {value}', 'Password for {value}', 'Verification code for {value}', 'Sign in to {value}'],
    disconnected:['Restarting the Antigravity server on {value}…', 'Reconnecting to {value}…', 'Disconnected from {value}',
      'Its server on {value} stopped, and its agents with it.', 'Agents keep running on {value}.',
      'Its agents on {value} stopped with it.', 'Agents keep running on {value} unless its server stopped.'],
    passkeys:['Scan this QR code with the camera on the device that has your passkey for {value}'],
  };
  function translate(raw) {
    if (kind === 'hud') {
      const row = /^Agent: ([\s\S]+) · ([\s\S]+) · (stopped|paused|foreground|background)$/.exec(raw);
      if (row) return format('Agent: {value}', row[1], 'Agent: ' + row[1]) + ' · ' + row[2] + ' · ' + exact(row[3]);
      const withStopped = /^(.+) \(\+(\d+) stopped\)$/.exec(raw);
      if (withStopped) return translate(withStopped[1]) + format(' (+{value} stopped)', withStopped[2], raw.slice(withStopped[1].length));
    }
    const direct = exact(raw);
    if (direct !== raw) return direct;
    for (const key of templates[kind] || []) {
      const [prefix, suffix] = key.split('{value}');
      if (raw.length > prefix.length + suffix.length && raw.startsWith(prefix) && raw.endsWith(suffix)) {
        return format(key, raw.slice(prefix.length, raw.length - suffix.length), raw);
      }
    }
    return raw;
  }
  let attributeRecord;
  function apply() {
    for (const element of document.querySelectorAll(selector)) {
      for (const node of element.childNodes) {
        if (node.nodeType !== 3) continue;
        const record = records.get(node);
        const raw = record && record.translated === node.data ? record.original : node.data;
        const trimmed = raw.trim();
        const translated = trimmed ? raw.replace(trimmed, () => translate(trimmed)) : raw;
        if (translated !== node.data) node.data = translated;
        if (translated === raw) records.delete(node);
        else records.set(node, {original:raw, translated});
      }
    }
    if (fixedAttribute) {
      const {selector, name, original} = fixedAttribute;
      const element = document.querySelector(selector);
      const current = element?.getAttribute(name);
      const previous = attributeRecord?.element === element ? attributeRecord?.translated : undefined;
      if (element && (current === original || current === previous)) {
        const translated = exact(original);
        if (translated !== current) element.setAttribute(name, translated);
        attributeRecord = {element, translated};
      }
    }
    for (const node of records.keys()) if (!node.isConnected) records.delete(node);
  }
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {childList:true, characterData:true, subtree:true});
  apply();
  return {
    version:'1', refresh(next) { strings = next.strings || next; apply(); },
    uninstall() {
      observer.disconnect();
      for (const [node, record] of records) if (node.data === record.translated) node.data = record.original;
      records.clear();
      if (attributeRecord) {
        const {name, original} = fixedAttribute;
        const {element, translated} = attributeRecord;
        if (element.getAttribute(name) === translated && translated !== original) element.setAttribute(name, original);
        attributeRecord = undefined;
      }
      if (document.documentElement.lang === 'zh-CN') {
        if (originalLanguage === null) document.documentElement.removeAttribute('lang');
        else document.documentElement.lang = originalLanguage;
      }
    },
  };
})
