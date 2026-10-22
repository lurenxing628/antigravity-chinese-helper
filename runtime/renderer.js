(function installAntigravityChinese(dictionary) {
  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1' || window.top !== window) return null;
  if (typeof window.electronNative?.getZoomLevel !== 'function' || typeof window.nativeStorage?.getItems !== 'function') return null;
  // The persistent CDP script also runs before Chromium creates the document.
  // The runner retries at DOMContentLoaded; an empty document has no UI to translate.
  if (!document.documentElement || !document.body) return null;
  window.__antigravityChineseHelper?.uninstall?.();

  const VERSION = '0.3.4';
  let strings = dictionary.strings || dictionary;
  let stopped = false;
  let flushTask = null;
  let cleanupTimer = null;
  let batches = 0;
  const createContextRingView = (function createContextRingView(document, anchor) {
  'use strict';

  const window = document.defaultView;
  // LGb is the app's own quota ring. Retain its React and global Tailwind styles.
  const nativeCache = createContextRingView.nativeByWindow ??= new WeakMap();
  if (!nativeCache.has(window)) {
    let component = null;
    const React = window.React, ReactDOM = window.ReactDOM;
    if (typeof React?.createElement === 'function' && typeof ReactDOM?.createRoot === 'function') {
      for (const name of Object.getOwnPropertyNames(window)) {
        const value = Object.getOwnPropertyDescriptor(window, name)?.value;
        if (typeof value !== 'function' || value === createContextRingView) continue;
        const source = Function.prototype.toString.call(value);
        if (source.includes('remainingFraction') && source.includes('quota-progress-circle')) { component = value; break; }
      }
    }
    nativeCache.set(window, component ? {component, React, ReactDOM} : null);
  }
  const native = nativeCache.get(window);
  function ContextNativeRing(props) {
    const element = native.component(props);
    const svg = native.React.Children.only(element.props.children);
    const fraction = props.remainingFraction;
    const color = fraction >= .9 ? 'stroke-red-500 dark:stroke-red-600'
      : fraction >= .75 ? 'stroke-yellow-500 dark:stroke-yellow-600'
      : 'stroke-green-500 dark:stroke-green-600';
    const children = native.React.Children.map(svg.props.children, child =>
      child?.props?.['data-testid'] === 'quota-progress-circle'
        ? native.React.cloneElement(child, {className:color}) : child);
    return native.React.cloneElement(element, null, native.React.cloneElement(svg, null, children));
  }
  const host = document.createElement('span');
  host.className = 'no-focus-agent-input';
  host.setAttribute('data-ch-keep', 'true');
  host.setAttribute('data-testid', 'context-usage-ring');
  const shadow = host.attachShadow({mode:'open'});
  const style = document.createElement('style');
  style.textContent = `
    :host { display:inline-flex; align-items:center; gap:4px; flex:0 0 auto; vertical-align:middle; margin-inline-start:3px; color:var(--secondary-foreground,#b6bbc4); }
    *, *::before, *::after { box-sizing:border-box; }
    [hidden] { display:none !important; }
    .ring-item { display:inline-flex; align-items:center; }
    button { position:relative; display:inline-grid; place-items:center; width:24px; height:24px; padding:2px; border:0; border-radius:50%; color:inherit; background:transparent; cursor:pointer; font:inherit; }
    button:hover, button[aria-expanded="true"] { background:var(--secondary,rgba(128,128,128,.15)); color:var(--foreground,#e8e8eb); }
    button:focus-visible { outline:1px solid var(--foreground,#e8e8eb); outline-offset:2px; }
    slot, .native-fallback { grid-area:1/1; }
    .native-fallback { display:block; width:20px; height:20px; border:2px solid var(--muted-foreground,#7d8795); border-radius:50%; opacity:.35; }
    .percentage { position:absolute; inset:0; z-index:3; display:grid; place-items:center; font:600 6.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:-.35px; font-variant-numeric:tabular-nums; pointer-events:none; }
    .tooltip { position:fixed; inset:auto; z-index:2147483000; width:260px; max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); margin:0; padding:6px 0; border:0; color:var(--foreground,#e8e8eb); background:transparent; overflow:auto; font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; text-align:left; user-select:text; }
    .panel { padding:12px 13px; border:1px solid var(--border,#3e4149); border-radius:11px; background:var(--card,#191b20); box-shadow:0 8px 28px rgba(0,0,0,.25); }
    .heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:9px; }
    .title { font-size:13px; font-weight:600; }
    dl { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:5px 14px; margin:0; }
    dt { color:var(--muted-foreground,#9199a6); }
    dd { min-width:0; margin:0; text-align:right; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  `;
  shadow.appendChild(style);

  const permanentListeners = [];
  const rings = [];
  let active = null;
  let disposed = false;
  let current = null;
  const numericKeys = ['used', 'maxContext', 'modelCapacity', 'compactionReference'];
  const clampFraction = value => Math.max(0, Math.min(1, value));
  const fractionText = value => value === null ? '—' : `${Math.round(value * 100)}%`;
  function formatTokens(value) {
    if (value >= 1000000) return `${Number((value / 1000000).toFixed(1))}M`;
    return `${(value / 1000).toFixed(2)} K`;
  }
  function listen(target, type, listener, options, collection = permanentListeners) {
    target.addEventListener(type, listener, options);
    collection.push(() => target.removeEventListener(type, listener, options));
  }
  function writeText(node, value) { if (node.textContent !== value) node.textContent = value; }
  function writeAttribute(node, name, value) { if (node.getAttribute(name) !== value) node.setAttribute(name, value); }
  function positionTooltip(ring) {
    if (!ring.open || !host.isConnected) return;
    const rect = ring.button.getBoundingClientRect(), bounds = ring.tooltip.getBoundingClientRect();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = document.documentElement.clientHeight || window.innerHeight;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const left = clamp(rect.left + rect.width / 2 - bounds.width / 2, 8, Math.max(8, width - bounds.width - 8));
    const preferredTop = rect.bottom + bounds.height <= height - 8 ? rect.bottom : rect.top - bounds.height;
    const top = clamp(preferredTop, 8, Math.max(8, height - bounds.height - 8));
    const x = `${Math.round(left)}px`, y = `${Math.round(top)}px`;
    if (ring.tooltip.style.left !== x) ring.tooltip.style.left = x;
    if (ring.tooltip.style.top !== y) ring.tooltip.style.top = y;
  }
  function dismiss(ring) {
    ring.pinned = ring.hovered = ring.focused = false;
    setOpen(ring, false);
  }
  function setOpen(ring, next) {
    if (disposed || next === ring.open || (next && !host.isConnected)) return;
    if (next && active && active !== ring) dismiss(active);
    ring.open = next;
    writeAttribute(ring.button, 'aria-expanded', String(next));
    if (next) {
      active = ring;
      ring.tooltip.hidden = false;
      if (ring.usePopover) {
        try { ring.tooltip.showPopover(); }
        catch { ring.tooltip.removeAttribute('popover'); ring.usePopover = false; }
      }
      positionTooltip(ring);
      listen(window, 'resize', () => positionTooltip(ring), {passive:true}, ring.openListeners);
      listen(document, 'scroll', () => positionTooltip(ring), {capture:true, passive:true}, ring.openListeners);
      listen(document, 'pointerdown', event => {
        if (!event.composedPath().includes(ring.item)) dismiss(ring);
      }, true, ring.openListeners);
      listen(document, 'keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(ring); }
      }, true, ring.openListeners);
    } else {
      for (const remove of ring.openListeners) remove();
      ring.openListeners = [];
      if (ring.usePopover && ring.tooltip.matches(':popover-open')) ring.tooltip.hidePopover();
      ring.tooltip.hidden = true;
      if (active === ring) active = null;
    }
  }
  function createRing(key, title, rows) {
    const item = document.createElement('span'); item.className = 'ring-item';
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'no-focus-agent-input'; button.dataset.ring = key;
    button.setAttribute('aria-label', `${title}：未返回`); button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-describedby', `context-${key}-tooltip`);
    const mount = document.createElement('span');
    mount.slot = `native-${key}`; mount.setAttribute('aria-hidden', 'true');
    mount.style.cssText = 'display:block;width:20px;height:20px;pointer-events:none;';
    host.appendChild(mount);
    const slot = document.createElement('slot'); slot.name = mount.slot;
    const fallback = document.createElement('span'); fallback.className = 'native-fallback'; fallback.hidden = Boolean(native);
    const percentage = document.createElement('span'); percentage.className = 'percentage'; percentage.textContent = '—';
    button.append(slot, fallback, percentage); item.appendChild(button);
    shadow.appendChild(item);
    const tooltip = document.createElement('div'); tooltip.className = 'tooltip no-focus-agent-input';
    tooltip.id = `context-${key}-tooltip`; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true;
    const usePopover = typeof tooltip.showPopover === 'function';
    if (usePopover) tooltip.setAttribute('popover', 'manual');
    const panel = document.createElement('div'); panel.className = 'panel';
    const heading = document.createElement('div'); heading.className = 'heading';
    const name = document.createElement('span'); name.className = 'title'; name.textContent = title; heading.appendChild(name);
    const details = document.createElement('dl'), values = {};
    for (const [rowKey, label] of rows) {
      const term = document.createElement('dt'); term.textContent = label;
      const value = document.createElement('dd'); value.textContent = '—';
      details.append(term, value); values[rowKey] = {term, value};
    }
    panel.append(heading, details); tooltip.appendChild(panel); item.appendChild(tooltip);
    const root = native ? native.ReactDOM.createRoot(mount) : null;
    const ring = {key, item, button, percentage, tooltip, values, root, usePopover,
      lastFraction:Symbol('initial'), open:false, hovered:false, focused:false, pinned:false, openListeners:[]};
    rings.push(ring);
    listen(item, 'pointerenter', () => { ring.hovered = true; setOpen(ring, true); });
    listen(item, 'pointerleave', () => { ring.hovered = false; setOpen(ring, ring.focused || ring.pinned); });
    listen(button, 'focus', () => { ring.focused = true; setOpen(ring, true); });
    listen(button, 'blur', () => { ring.focused = false; setOpen(ring, ring.hovered || ring.pinned); });
    listen(button, 'pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
    listen(button, 'mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    listen(button, 'click', event => {
      event.preventDefault(); event.stopPropagation();
      if (ring.pinned) dismiss(ring); else { ring.pinned = true; setOpen(ring, true); }
    });
    listen(button, 'keydown', event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); });
    renderFraction(ring, null);
    return ring;
  }
  function renderFraction(ring, fraction) {
    writeText(ring.percentage, native ? fractionText(fraction) : '—');
    if (ring.lastFraction === fraction) return;
    ring.lastFraction = fraction;
    if (ring.root) ring.root.render(native.React.createElement(ring.key === 'context' ? ContextNativeRing : native.component, {
      remainingFraction:fraction ?? undefined, disabled:false, className:'w-full h-full',
    }));
  }

  const context = createRing('context', '上下文用量', [
    ['used', '当前已用上下文'], ['compactionReference', '压缩阈值'], ['maxContext', '总可用上下文'],
    ['modelCapacity', '模型实际上下文'], ['ratio', '使用比例'],
  ]);
  const quotaRows = [['remaining', '剩余比例']];
  const fiveHour = createRing('five-hour', '5 小时额度', quotaRows);
  const weekly = createRing('weekly', '每周额度', quotaRows);
  listen(host, 'pointerdown', event => event.stopPropagation());
  listen(host, 'mousedown', event => event.stopPropagation());
  listen(host, 'click', event => event.stopPropagation());

  function normalizeQuota(quota) {
    const fraction = quota?.remainingFraction;
    return {remainingFraction:typeof fraction === 'number' && Number.isFinite(fraction) ? clampFraction(fraction) : null,
      disabled:quota?.disabled === true};
  }
  const sameQuota = (a, b) => a.remainingFraction === b.remainingFraction && a.disabled === b.disabled;
  function updateQuota(ring, quota) {
    const fraction = quota.disabled ? null : quota.remainingFraction;
    const text = fractionText(fraction);
    renderFraction(ring, fraction); writeText(ring.values.remaining.value, text);
    writeAttribute(ring.button, 'aria-label', `${ring.key === 'weekly' ? '每周额度' : '5 小时额度'}：剩余 ${text}`);
  }
  function update(snapshot) {
    if (disposed) return false;
    const next = {};
    for (const key of numericKeys) {
      const value = snapshot?.[key];
      next[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    }
    next.weeklyQuota = normalizeQuota(snapshot?.weeklyQuota); next.fiveHourQuota = normalizeQuota(snapshot?.fiveHourQuota);
    if (current && numericKeys.every(key => current[key] === next[key]) &&
        sameQuota(current.weeklyQuota, next.weeklyQuota) && sameQuota(current.fiveHourQuota, next.fiveHourQuota)) return false;
    current = next;
    const limit = next.maxContext > 0 ? next.maxContext : next.compactionReference > 0 ? next.compactionReference : null;
    const usedFraction = next.used !== null && limit !== null ? clampFraction(next.used / limit) : null;
    const text = fractionText(usedFraction);
    renderFraction(context, usedFraction);
    for (const key of numericKeys) writeText(context.values[key].value, next[key] === null ? '—' : formatTokens(next[key]));
    writeText(context.values.ratio.value, text);
    writeAttribute(context.button, 'aria-label', `上下文已用：${text}；已用 ${next.used === null ? '未返回' : formatTokens(next.used)}；压缩阈值 ${next.compactionReference === null ? '未返回' : formatTokens(next.compactionReference)}；总可用 ${limit === null ? '未返回' : formatTokens(limit)}`);
    updateQuota(weekly, next.weeklyQuota); updateQuota(fiveHour, next.fiveHourQuota);
    if (active) positionTooltip(active);
    return true;
  }

  return {
    host,
    update,
    dispose() {
      if (disposed) return;
      if (active) dismiss(active);
      disposed = true;
      for (const remove of permanentListeners) remove();
      permanentListeners.length = 0;
      for (const ring of rings) ring.root?.unmount();
      host.remove();
    }
  };
});
  const createContextRingController = (function createContextRingController(document, createView) {
  'use strict';
  const selector = '[data-testid="model-selector-trigger"]';
  const instances = new Map();
  const clients = new WeakMap();
  let stopped = false;
  const quotaHubs = new Map();
  const appWindow = document.defaultView;
  const nativeQuotaReader = Object.getOwnPropertyNames(appWindow).map(key => Object.getOwnPropertyDescriptor(appWindow,key)?.value)
    .find(value => typeof value === 'function' && (() => {
      const source = Function.prototype.toString.call(value);
      return source.includes('retrieveUserQuotaSummary') && source.includes('Promise.resolve') && /5E3|5000/.test(source);
    })());
  function quotaFamily(label) {
    if (/gemini/i.test(label ?? '')) return 'gemini';
    if (/claude|gpt|openai|\bo[134]\b/i.test(label ?? '')) return '3p';
    return null;
  }
  function quotaValues(instance, modelLabel) {
    const selected = instance.selected;
    const family = quotaFamily(selected?.label) ?? (!selected || selected.modelAlias ? quotaFamily(modelLabel) : null);
    const buckets = (instance.quotaHub?.groups ?? []).flatMap(group => group.buckets.filter(bucket =>
      family === 'gemini' ? bucket.bucketId.startsWith('gemini-') : family === '3p' ? bucket.bucketId.startsWith('3p-') : false));
    return {weeklyQuota:buckets.find(bucket => bucket.window === 'weekly') ?? null,
      fiveHourQuota:buckets.find(bucket => bucket.window === '5h') ?? null,
      quotaModelLabel:selected?.label ?? modelLabel ?? null};
  }
  function quotaHub(client, service) {
    const key = client ?? service;
    if (!key || typeof service?.retrieveUserQuotaSummary !== 'function') return null;
    let hub = quotaHubs.get(key);
    if (hub) { hub.service = service; return hub; }
    hub = {groups:[], listeners:new Set(), service, active:true, pending:null, requestedAt:-Infinity};
    const descriptor = Object.getOwnPropertyDescriptor(client ?? {}, 'retrieveUserQuotaSummary');
    const owner = descriptor?.writable && typeof descriptor.value === 'function' ? client : service;
    const methodDescriptor = Object.getOwnPropertyDescriptor(owner, 'retrieveUserQuotaSummary');
    const original = owner.retrieveUserQuotaSummary;
    function publish(result) {
      if (!hub.active) return;
      const groups = Array.isArray(result) ? result : result?.response?.groups ?? result?.groups;
      if (!Array.isArray(groups)) return;
      hub.groups = groups.map(group => ({buckets:(group.buckets ?? []).map(bucket => {
        const fraction = bucket.remaining?.case === 'remainingFraction' ? bucket.remaining.value : null;
        const seconds = bucket.resetTime?.seconds;
        return {bucketId:bucket.bucketId ?? '', window:bucket.window ?? '', disabled:bucket.disabled === true,
          remainingFraction:typeof fraction === 'number' && Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : null,
          resetAtMs:seconds !== undefined ? Number(seconds)*1000 + Number(bucket.resetTime.nanos ?? 0)/1000000 : null};
      })}));
      for (const listener of hub.listeners) listener();
    }
    const wrapper = function quotaResponse(...args) {
      const result = original.apply(this,args);
      if (result?.then) result.then(publish, () => {});
      else publish(result);
      return result;
    };
    const hooked = methodDescriptor?.writable === true;
    if (hooked) owner.retrieveUserQuotaSummary = wrapper;
    hub.refresh = urgent => {
      if (!hub.active || hub.pending || (!urgent && Date.now()-hub.requestedAt < 30000)) return;
      hub.requestedAt = Date.now();
      const read = Promise.resolve().then(() => nativeQuotaReader
        ? nativeQuotaReader(hub.service,false)
        : hub.service.retrieveUserQuotaSummary(undefined,false));
      hub.pending = read;
      read.then(publish, () => {}).finally(() => { if (hub.pending === read) hub.pending = null; });
    };
    hub.dispose = () => {
      hub.active = false; hub.listeners.clear();
      if (hooked && owner.retrieveUserQuotaSummary === wrapper) owner.retrieveUserQuotaSummary = original;
      quotaHubs.delete(key);
    };
    quotaHubs.set(key, hub);
    return hub;
  }
  function bindQuota(instance, service) {
    if (instance.quotaService === service && instance.quotaClient === instance.client) return;
    releaseQuota(instance);
    instance.quotaService = service; instance.quotaClient = instance.client;
    const hub = quotaHub(instance.client,service);
    if (!hub) return;
    instance.quotaHub = hub;
    instance.quotaListener = () => queueUpdate(instance);
    hub.listeners.add(instance.quotaListener);
    hub.refresh(true);
  }
  function releaseQuota(instance) {
    const hub = instance.quotaHub;
    if (hub) {
      hub.listeners.delete(instance.quotaListener);
      if (!hub.listeners.size) hub.dispose();
    }
    instance.quotaHub = null; instance.quotaListener = null;
  }

  const positive = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
  const count = value => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };
  const currentFiber = element => {
    const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    let fiber = key && element[key];
    let root = fiber;
    while (root?.return) root = root.return;
    if (root?.stateNode?.current && root.stateNode.current !== root && fiber?.alternate) fiber = fiber.alternate;
    return fiber;
  };
  function bindings(element) {
    let fiber = currentFiber(element), provider, client, selected, quotaService;
    while (fiber) {
      const props = fiber.memoizedProps, value = props?.value;
      provider ??= value?.cascadeContext?.state?.agentStateProvider;
      selected ??= value?.selectedModel;
      const services = props?.services ?? (value?.core ? value : null);
      quotaService ??= services?.core?.cloudCodeService;
      const raw = services?.core?.authService?._lsClient;
      if (raw && !client) client = typeof raw.getState === 'function' ? raw.getState() : raw;
      fiber = fiber.return;
    }
    return {provider, client, selected, quotaService};
  }
  function clientCache(client) {
    let cache = clients.get(client);
    if (!cache) { cache = {catalog: null, configs: new Map()}; clients.set(client, cache); }
    return cache;
  }
  function catalog(client) {
    const cache = clientCache(client);
    if (!cache.catalog) {
      cache.catalog = Promise.resolve().then(() => client.getAvailableModels({forceRefresh:false})).then(result => {
        const values = result?.response?.models ?? result?.models ?? {};
        const models = new Map();
        for (const [name, value] of Object.entries(values)) {
          const model = {capacity:positive(value.maxTokens), output:positive(value.maxOutputTokens), label:value.displayName || name};
          models.set(String(value.model), model);
          models.set(name, model);
        }
        return models;
      }).catch(error => { cache.catalog = null; throw error; });
    }
    return cache.catalog;
  }
  function configKey(planner) {
    return [planner?.planModel, planner?.modelName, planner?.truncationThresholdTokens,
      planner?.maxOutputTokens, planner?.customModelInfoOverride?.maxTokens,
      planner?.customModelInfoOverride?.maxOutputTokens].join('|');
  }
  function resolvedConfig(client, planner) {
    const cache = clientCache(client), key = configKey(planner);
    if (!cache.configs.has(key)) {
      const promise = Promise.resolve().then(() => client.getResolvedCascadeConfig({overrideConfig:{plannerConfig:planner}}))
        .then(result => {
          const config = result?.cascadeConfig;
          const checkpoint = config?.checkpointConfig;
          // Retain only numeric configuration, never prompts or conversation text.
          return {key, modelCount:checkpoint?.useModelReportedTokenCount === true, enabled:checkpoint?.enabled === true, limit:positive(checkpoint?.maxTokenLimit),
            output:positive(config?.plannerConfig?.maxOutputTokens)};
        }).catch(error => { cache.configs.delete(key); throw error; });
      cache.configs.set(key, promise);
    }
    return cache.configs.get(key);
  }
  function usageTotal(usage) {
    if (!usage) return null;
    const input = count(usage.inputTokens), output = count(usage.outputTokens), cache = count(usage.cacheReadTokens ?? 0);
    if (input === null || output === null || cache === null) return null;
    const total = input + cache + output;
    return total > 0 ? total : null;
  }
  function usageFrom(meta) {
    for (let i = (meta?.retryInfos?.length ?? 0) - 1; i >= 0; i--) {
      const total = usageTotal(meta.retryInfos[i].usage);
      if (total !== null) return total;
    }
    return usageTotal(meta?.usage);
  }
  function scalarState(state) {
    const slice = state?.trajectorySlice ?? {};
    const metas = slice.generatorMetadatasInSlice ?? [];
    const generator = metas[metas.length - 1];
    const steps = slice.stepsInSlice ?? [];
    const start = count(slice.stepsSlice?.startIndex) ?? Math.max(0, (count(slice.totalStepsLength) ?? steps.length) - steps.length);
    let latestUsage = null;
    for (let i = steps.length - 1; i >= 0; i--) {
      const usage = steps[i].metadata?.modelUsage, total = usageTotal(usage);
      if (total !== null) {
        latestUsage = {step:start + i, total, model:usage.model};
        break;
      }
    }
    return {id:state?.conversationId, generation:count(slice.totalGeneratorMetadataLength) ?? 0,
      generator, usage:latestUsage, idle:state?.fullyIdle === true};
  }
  function disposeSubscription(subscription) {
    if (typeof subscription === 'function') subscription();
    else subscription?.dispose?.();
  }
  function mount(anchor) {
    const view = createView(document, anchor);
    // The app's own no-focus wrapper is already a child of its flex toolbar.
    // Keep the new button outside the native model-menu trigger and its wrapper.
    const placement = anchor.closest('.no-focus-agent-input') ?? anchor;
    placement.after(view.host);
    const instance = {anchor, view, provider:null, client:null, selected:null, subscription:null,
      epoch:0, queued:false, disposed:false, state:null, record:null, models:null, config:null,
      wanted:null, requested:null, requestedKeys:new Set(), requestBase:null, inFlight:false, lastError:null, snapshot:null};
    instances.set(anchor, instance);
    rebind(instance);
    return instance;
  }
  function valid(instance, epoch) {
    return !stopped && !instance.disposed && instance.epoch === epoch && instance.anchor.isConnected;
  }
  function selectedModel(instance) { return instance.selected?.value ?? instance.selected?.modelAlias; }
  function render(instance) {
    if (instance.disposed) return;
    const state = instance.state, record = instance.record;
    const modelId = record?.model ?? selectedModel(instance);
    const model = instance.models?.get(String(modelId));
    const capacity = record?.customCapacity ?? model?.capacity ?? null;
    const config = instance.config;
    const maxContext = record?.maxContext ?? positive(instance.anchor.getAttribute('data-context-window'));
    const output = config?.output ?? null;
    // Native ClampCheckpointConfigForModelInfo clamps checkpoint.maxTokenLimit
    // to model capacity minus the planner output limit. The converter then uses
    // the smaller model/checkpoint budget; tokenThreshold and overhead are not
    // subtracted from that budget. Respect the actual request window as well.
    let compaction = config?.enabled ? config.limit : null;
    if (compaction !== null) {
      if (capacity !== null) compaction = Math.min(compaction, Math.max(0, capacity - (output ?? 0)));
      if (maxContext !== null) compaction = Math.min(compaction, maxContext);
    }
    let used = record?.usage ?? null;
    if (record && state?.usage && record.steps.includes(state.usage.step) &&
        (state.usage.model === undefined || String(state.usage.model) === String(modelId))) used = state.usage.total;
    const estimated = used === null && record?.estimated !== null && record?.estimated !== undefined;
    if (estimated) used = record.estimated;
    const current = record && state && record.generation === state.generation;
    const snapshotLabel = record
      ? `${current ? '本次调用' : '上次调用'} · ${estimated ? '后端估算' : '模型统计'}${state?.idle === false ? ' · 运行中' : ''}`
      : state?.generation ? (instance.lastError ? '读取失败，可随下次调用重试' : '等待本次调用数据') : '尚未开始调用';
    const label = record?.label || model?.label || record?.responseLabel || (String(modelId) === String(selectedModel(instance)) ? instance.selected?.label : null);
    const snapshot = {used, maxContext, modelCapacity:capacity, compactionReference:compaction,
      outputReserve:output, estimatedTokens:record?.estimated ?? null,
      compactionBasisLabel:config ? (config.modelCount ? '模型报告用量' : '后端估算') : null,
      snapshotLabel, modelLabel:label ?? null,
      selectedLabel:instance.selected?.label ?? null, ...quotaValues(instance,label)};
    instance.snapshot = snapshot;
    viewUpdate(instance, snapshot);
  }
  function viewUpdate(instance, snapshot) { instance.view.update(snapshot); }
  function requestConfig(instance, planner, epoch) {
    if (!instance.client || typeof instance.client.getResolvedCascadeConfig !== 'function' || !planner) return;
    const key = configKey(planner);
    if (instance.config?.key === key || instance.configPending === key) return;
    const attempt = `${key}:${instance.state?.generation ?? 0}`;
    if (instance.configAttempted === attempt) return;
    instance.configAttempted = attempt; instance.config = null;
    instance.configPending = key;
    resolvedConfig(instance.client, planner).then(config => {
      if (!valid(instance, epoch) || instance.configPending !== key) return;
      instance.configPending = null; instance.config = config; render(instance);
    }).catch(() => {
      if (valid(instance, epoch) && instance.configPending === key) { instance.configPending = null; instance.lastError = 'config'; render(instance); }
    });
  }
  function acceptRecord(instance, generator, generation, epoch) {
    const meta = generator?.metadata?.case === 'chatModel' ? generator.metadata.value : null;
    if (!meta) return false;
    const context = meta.chatStartMetadata?.contextWindowMetadata;
    instance.record = {generation, model:meta.model, label:meta.modelDisplayName || null, responseLabel:meta.responseModel || null,
      steps:Array.from(generator.stepIndices ?? []), usage:usageFrom(meta), estimated:count(context?.estimatedTokensUsed),
      maxContext:positive(context?.maxContextTokens), planner:generator.plannerConfig, customCapacity:positive(generator.plannerConfig?.customModelInfoOverride?.maxTokens)};
    requestConfig(instance, generator.plannerConfig, epoch);
    instance.lastError = null;
    return true;
  }
  async function requestLatest(instance) {
    if (instance.inFlight || !instance.wanted || instance.requestedKeys.has(instance.wanted.key) || !instance.client ||
        typeof instance.client.getCascadeTrajectoryGeneratorMetadata !== 'function') return;
    instance.inFlight = true;
    const epoch = instance.epoch, wanted = instance.wanted;
    instance.requested = wanted.key; instance.requestedKeys.add(wanted.key);
    try {
      const response = await instance.client.getCascadeTrajectoryGeneratorMetadata({cascadeId:wanted.id,
        generatorMetadataOffset:Math.max(0, wanted.generation - 1), includeMessages:false});
      if (!valid(instance, epoch)) return;
      if (instance.wanted?.id === wanted.id && instance.wanted?.generation === wanted.generation) {
        const records = response?.generatorMetadata ?? [];
        for (let i = records.length - 1; i >= 0; i--) {
          if (acceptRecord(instance, records[i], wanted.generation, epoch)) break;
        }
        render(instance);
      }
    } catch {
      if (valid(instance, epoch)) { instance.lastError = 'metadata'; render(instance); }
    } finally {
      if (valid(instance, epoch)) {
        instance.inFlight = false;
        if (instance.wanted && !instance.requestedKeys.has(instance.wanted.key)) requestLatest(instance);
      }
    }
  }
  function update(instance) {
    if (instance.disposed || stopped) return;
    let state;
    try { state = instance.provider?.getState?.(); } catch { instance.lastError = 'state'; }
    const next = scalarState(state);
    const viewId = instance.anchor.closest('[data-cascade-id]')?.getAttribute('data-cascade-id');
    if (next.id && viewId && next.id !== viewId) { instance.record = null; instance.state = null; instance.config = null; render(instance); return; }
    if (instance.state?.id && next.id !== instance.state.id) {
      // A reused native provider must not carry the previous conversation's data.
      instance.record = null; instance.config = null; instance.requested = null;
    }
    instance.state = next;
    const quotaEvent = `${next.id}:${next.generation}:${next.idle}`;
    if (instance.quotaEvent !== quotaEvent) {
      const finished = next.idle && instance.quotaIdle === false;
      instance.quotaEvent = quotaEvent; instance.quotaIdle = next.idle; instance.quotaHub?.refresh(finished);
    }
    const epoch = instance.epoch;
    const inMemory = next.generator;
    if (inMemory?.metadata?.case === 'chatModel') acceptRecord(instance, inMemory, next.generation, epoch);
    else if (instance.record?.generation === next.generation && inMemory?.stepIndices?.length) instance.record.steps = Array.from(inMemory.stepIndices);
    const planner = instance.record?.planner ?? inMemory?.plannerConfig ?? (instance.selected ? {planModel:selectedModel(instance)} : null);
    requestConfig(instance, planner, epoch);
    if (next.id && next.id !== '_new' && next.generation > 0) {
      const hasCurrentUsage = next.usage && inMemory?.stepIndices?.includes(next.usage.step);
      const base = `${next.id}:${next.generation}`;
      if (instance.requestBase !== base) { instance.requestBase = base; instance.requestedKeys.clear(); }
      const retryUsage = instance.record?.generation !== next.generation && hasCurrentUsage &&
        instance.requestedKeys.has(`${base}:start`) && !instance.inFlight;
      const phase = next.idle ? 'idle' : retryUsage ? 'usage' : 'start';
      const key = `${base}:${phase}`;
      instance.wanted = {id:next.id, generation:next.generation, key};
      if (!instance.requestedKeys.has(key)) requestLatest(instance);
    } else instance.wanted = null;
    render(instance);
  }
  function queueUpdate(instance) {
    if (instance.queued || stopped || instance.disposed) return;
    instance.queued = true;
    queueMicrotask(() => { instance.queued = false; if (!instance.disposed && !stopped) update(instance); });
  }
  function rebind(instance) {
    if (stopped || instance.disposed || !instance.anchor.isConnected) return;
    const next = bindings(instance.anchor);
    const changed = next.provider !== instance.provider || next.client !== instance.client;
    const previousModel = selectedModel(instance);
    instance.selected = next.selected;
    if (changed) {
      disposeSubscription(instance.subscription);
      instance.subscription = null;
      instance.epoch++;
      instance.provider = next.provider; instance.client = next.client;
      instance.state = instance.record = instance.config = instance.wanted = instance.requested = null;
      instance.requestedKeys.clear(); instance.requestBase = null;
      instance.configPending = null; instance.configAttempted = null; instance.inFlight = false; instance.models = null;
      const epoch = instance.epoch;
      if (typeof next.provider?.onDidChange === 'function') instance.subscription = next.provider.onDidChange(() => queueUpdate(instance));
      if (next.client && typeof next.client.getAvailableModels === 'function') {
        catalog(next.client).then(models => {
          if (!valid(instance, epoch)) return;
          instance.models = models; render(instance);
        }).catch(() => { if (valid(instance, epoch)) { instance.lastError = 'models'; render(instance); } });
      }
    }
    bindQuota(instance,next.quotaService);
    if (previousModel !== selectedModel(instance)) instance.quotaHub?.refresh(true);
    update(instance);
  }
  function disposeInstance(instance) {
    if (instance.disposed) return;
    instance.disposed = true; instance.epoch++;
    disposeSubscription(instance.subscription);
    releaseQuota(instance);
    instance.view.dispose(); instances.delete(instance.anchor);
  }
  return {
    selector,
    discover(element) {
      if (stopped || !element.matches?.(selector)) return;
      const existing = instances.get(element);
      if (existing) rebind(existing); else mount(element);
    },
    mutations(mutations) {
      if (stopped || !instances.size) return;
      const dirty = new Set();
      for (const mutation of mutations) {
        const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        for (const instance of instances.values()) {
          if (instance.anchor.contains(target) ||
              (mutation.type === 'attributes' && mutation.attributeName === 'data-cascade-id' && target.contains(instance.anchor))) dirty.add(instance);
        }
      }
      for (const instance of dirty) rebind(instance);
    },
    cleanup() { for (const instance of instances.values()) if (!instance.anchor.isConnected) disposeInstance(instance); },
    dispose() { stopped = true; for (const instance of instances.values()) disposeInstance(instance); },
    status() { return [...instances.values()].map(instance => ({bound:Boolean(instance.provider && instance.client), ...instance.snapshot})); },
    get size() { return instances.size; }
  };
});
  const installStatusFormatters = (function installStatusFormatters(options) {
  'use strict';
  let {strings, register} = options;

  const hooks = [];
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const sourceOf = fn => Function.prototype.toString.call(fn);
  const identifier = '[A-Za-z_$][\\w$]*';
  const prefixLabels = {
    Analyzing: '正在分析',
    Analyzed: '已分析',
    Found: '已找到',
    Finding: '正在查找',
    Run: '运行',
    Running: '运行中',
    Ran: '已运行',
    ran: '已运行',
    'Running command': '正在运行命令',
    command: '命令',
    commands: '命令',
    Rejected: '已拒绝',
    Canceled: '已取消',
    Searching: '正在搜索',
    Searched: '已搜索',
    Reading: '正在读取',
    Read: '已读取',
    Editing: '正在编辑',
    Edited: '已编辑',
    edited: '已编辑',
    Viewing: '正在查看',
    Viewed: '已查看',
    Listing: '正在列出',
    Listed: '已列出',
    Creating: '正在创建',
    Created: '已创建',
    Opening: '正在打开',
    Opened: '已打开',
    Edit: '编辑',
    edit: '编辑',
    Writing: '正在写入',
    Written: '已写入',
    Wrote: '已写入',
    Deleting: '正在删除',
    Deleted: '已删除',
    Errored: '运行出错',
    Starting: '正在启动',
    Started: '已启动',
    Waiting: '等待中',
    Working: '处理中',
    Thinking: '正在思考',
    Compacting: '正在压缩',
    Exploring: '正在查看',
    Explored: '已查看',
    Done: '完成',
    'Canceled edit to': '已取消编辑',
    'Canceled creation of': '已取消创建',
    'Canceled deletion of': '已取消删除',
    'Analyzing content': '正在分析内容',
    'Analyzed content': '已分析内容',
    'Reading page': '正在读取页面',
    'Read page': '已读取页面',
    'Failed to read': '读取失败',
    'Searching Moma for': '正在搜索 Moma',
    'Searched Moma for': '已搜索 Moma'
  };

  function label(original, fallback) {
    const values = strings?.strings || strings;
    return values && own(values, original) && typeof values[original] === 'string'
      ? values[original]
      : fallback;
  }

  function thinkingText(text) {
    if (text === 'Thinking') return label('Thinking', '正在思考');
    if (text === 'Thought Process') return label('Thought Process', '思考过程');
    const match = /^(Thinking|Thought) for (\d+)s$/.exec(text);
    if (!match) return text;
    // Preserve the native digit string. Its own transition component still owns
    // segmentation, elapsed-time updates, reduced motion and width measurement.
    const state = match[1] === 'Thinking'
      ? label('Thinking', '正在思考')
      : label('Thought', '已思考');
    return `${state} ${match[2]}秒`;
  }

  function install(key, original, wrapper, kind, owner = window) {
    owner[key] = wrapper;
    hooks.push({key, original, wrapper, kind, owner});
    // register records the installed hook for the owner's existing uninstall
    // path. The returned hooks array supports owners which collect them later.
    register?.(key, original, wrapper, kind, owner);
  }

  const nativeFunctions = Object.getOwnPropertyNames(window).flatMap(key => {
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    return descriptor?.writable && typeof descriptor.value === 'function'
      ? [{key, original: descriptor.value, source: sourceOf(descriptor.value)}]
      : [];
  });
  function readBinding(name) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    if (descriptor && own(descriptor, 'value')) return descriptor.value;
    return new RegExp(`^${identifier}$`).test(name) && typeof window.eval === 'function'
      ? window.eval(name)
      : undefined;
  }
  function fixed(original) {
    const key = original === 'ran' ? 'Ran' : original === 'edited' ? 'Edited' : original;
    return own(prefixLabels, key) ? label(key, prefixLabels[key]) : original;
  }
  // Recompile only the three identified pure native formatters. Replacing their
  // output literals preserves every dynamic path/query/command/summary byte.
  // Capturing referenced globals also makes the same mechanism usable in the
  // isolated test window; function-local bindings continue to take precedence.
  function compileFormatter(source) {
    const tokens = new Set(source.match(/[A-Za-z_$][\w$]*/g));
    const names = [], values = [];
    for (const name of Object.getOwnPropertyNames(window)) {
      if (!tokens.has(name) || !new RegExp(`^${identifier}$`).test(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(window, name);
      if (!descriptor || !own(descriptor, 'value')) continue;
      names.push(name);values.push(descriptor.value);
    }
    return new Function(...names, '__chStatusLabel', `return (${source})`)(...values, fixed);
  }
  function localizeLiterals(entry, words, templates = []) {
    let source = entry.source;
    for (const word of words) source = source.split(JSON.stringify(word)).join(`(__chStatusLabel(${JSON.stringify(word)}))`);
    for (const word of templates) source = source.split('`' + word + ' ${').join('`${__chStatusLabel(' + JSON.stringify(word) + ')} ${');
    return source === entry.source ? null : compileFormatter(source);
  }

  let prefixEntry = null;
  let transitionEntry = null;
  for (const entry of nativeFunctions) {
    const {key, source} = entry;
    if (!['prefix', 'content', 'progressMessage', 'customTitle', 'tooltipText']
      .every(prop => new RegExp(`\\b${prop}\\s*:`).test(source))) continue;

    const prefixParameter = source.match(new RegExp(`\\bprefix\\s*:\\s*(${identifier})`))?.[1];
    if (!prefixParameter) continue;
    // Find the transition component receiving the prefix variable, rather than
    // the separate content variable. Both use createElement(..., {text: ...}).
    const calls = source.matchAll(new RegExp(
      `typeof\\s+(${identifier})\\s*===\\s*["']string["']\\s*\\?\\s*` +
      `${identifier}\\.createElement\\(\\s*(${identifier})\\s*,\\s*` +
      `\\{\\s*text\\s*:\\s*\\1\\s*\\}`,
      'g'
    ));
    for (const call of calls) {
      if (call[1] !== prefixParameter) continue;
      const transitionKey = call[2];
      const transitionDescriptor = Object.getOwnPropertyDescriptor(window, transitionKey);
      if (!transitionDescriptor?.writable || typeof transitionDescriptor.value !== 'function') continue;
      const transitionSource = sourceOf(transitionDescriptor.value);
      if (!/\.createElement\(/.test(transitionSource) || !/\.Fragment\b/.test(transitionSource) || !/\.text\b/.test(transitionSource)) continue;
      prefixEntry = entry;
      transitionEntry = {key: transitionKey, original: transitionDescriptor.value};
      break;
    }
    if (prefixEntry) break;
  }

  const pathEntry = nativeFunctions.find(entry => entry.source.includes('directoryPathUri') && entry.source.includes('read_file') && entry.source.includes('`Searching ${'));
  const runningEntry = nativeFunctions.find(entry => entry.source.includes('"Running command"') && entry.source.includes('"Exploring"') && entry.source.includes('toolSummary:'));
  const groupEntry = nativeFunctions.find(entry => /\bsteps\s*:/.test(entry.source) && /\bisRunning\s*:/.test(entry.source) && entry.source.includes('"Ran":"ran"') && entry.source.includes('"Explored"'));
  for (const [entry, words, templates, kind] of [
    [pathEntry, [], ['Editing', 'Reading', 'Listing', 'Searching'], 'status-path'],
    [runningEntry, ['Running command', 'Exploring'], ['Editing'], 'status-running'],
    [groupEntry, ['Working', 'Thinking', 'Explored', 'Ran', 'ran', 'command', 'commands', 'Edited', 'edited', 'Done'], ['Explored'], 'status-group']
  ]) {
    if (!entry) continue;
    const localized = localizeLiterals(entry, words, templates);
    if (localized) install(entry.key, entry.original, localized, kind);
  }

  const shimmerEntry = nativeFunctions.find(entry => entry.source.includes('"animate-shimmer-text"') && /\bchildren\s*:/.test(entry.source) && /\bactive\s*:/.test(entry.source));
  if (shimmerEntry) install(shimmerEntry.key, shimmerEntry.original, function statusShimmer(props, ...args) {
    let next = props;
    if (props && typeof props.children === 'string') {
      let text = fixed(props.children);
      const count = /^(\d+) (subagents\/tasks|subagents?|tasks?) running(?:, (\d+) blocked)?$/.exec(props.children);
      const blocked = /^(\d+) subagents? blocked$/.exec(props.children);
      if (count) {
        const noun = count[2] === 'subagents/tasks' ? '子代理/任务' : count[2].startsWith('subagent') ? '子代理' : '任务';
        text = `${count[1]} 个${noun}运行中${count[3] ? `，${count[3]} 个受阻` : ''}`;
      } else if (blocked) text = `${blocked[1]} 个子代理受阻`;
      // Never descend into React children: search queries, file names and
      // custom titles may be nested there and belong to their original owners.
      if (text !== props.children) next = {...props, children: text};
    }
    return shimmerEntry.original.call(this, next, ...args);
  }, 'status-shimmer');

  const headerEntry = nativeFunctions.find(entry => entry.source.includes('!text-clip') && entry.source.includes('pl-2 truncate max-w-[500px]'));
  const selectorName = headerEntry?.source.match(new RegExp(`(${identifier})=(${identifier})\\(\\1,(${identifier}),${identifier}\\);return`))?.[3];
  const selectorOwner = selectorName && readBinding(selectorName);
  if (typeof selectorOwner?.selector === 'function' && sourceOf(selectorOwner.selector).includes('"Agent Stopped"')) {
    const original = selectorOwner.selector;
    install('selector', original, function statusAgentSelector(...args) {
      const text = original.apply(this, args);
      if (typeof text !== 'string') return text;
      if (text === 'Agent Stopped') return label(text, '智能体已停止');
      if (text === 'Agent is analyzing videos') return label(text, '正在分析视频');
      if (text.startsWith('Executing task: ')) return '正在执行任务：' + text.slice('Executing task: '.length);
      return fixed(text);
    }, 'status-agent-selector', selectorOwner);
  }

  if (prefixEntry && transitionEntry) {
    const transitionOriginal = transitionEntry.original;
    install(transitionEntry.key, transitionOriginal, function statusThinking(props, ...args) {
      let next = props;
      // In this app only UEb supplies an own persistKey, including when its
      // metadata is absent and the value is undefined. aZ's arbitrary content
      // (file names, commands and summaries) never supplies that property.
      if (props && own(props, 'persistKey') && typeof props.text === 'string' &&
        (props.persistKey === undefined ||
          (typeof props.persistKey === 'string' && props.persistKey.startsWith('thinking:')))) {
        const text = thinkingText(props.text);
        if (text !== props.text) {
          next = {...props, text};
          // Separate the native transition cache from its prior English value.
          // Undefined remains undefined, so no synthetic shared cache is added.
          if (typeof props.persistKey === 'string') next.persistKey = `ch:${props.persistKey}`;
        }
      }
      return transitionOriginal.call(this, next, ...args);
    }, 'status-thinking');

    const prefixOriginal = prefixEntry.original;
    install(prefixEntry.key, prefixOriginal, function statusPrefix(props, ...args) {
      let next = props;
      // The prefix is a separate native label. Never inspect or translate
      // content, customTitle, progressMessage, tool arguments or command text.
      if (props && typeof props.prefix === 'string' && own(prefixLabels, props.prefix)) {
        const prefix = label(props.prefix, prefixLabels[props.prefix]);
        if (prefix !== props.prefix) next = {...props, prefix};
      }
      return prefixOriginal.call(this, next, ...args);
    }, 'status-prefix');
  }

  return {
    count: hooks.length,
    hooks,
    prefixKey: prefixEntry?.key ?? null,
    thinkingKey: transitionEntry?.key ?? null,
    formatterKeys: {path: pathEntry?.key ?? null, running: runningEntry?.key ?? null, group: groupEntry?.key ?? null, shimmer: shimmerEntry?.key ?? null, selector: selectorName ?? null},
    // The renderer replaces its dictionary on refresh; keep that existing
    // operation responsible for updating the hook's dictionary reference too.
    setStrings(next) { strings = next; }
  };
});
  const contextRings = createContextRingController(document, createContextRingView);
  let statusFormatters = null;
  const texts = new Map();
  const attributes = new Map();
  const pendingRoots = new Set();
  const pendingTexts = new Set();
  const pendingAttributes = new Map();
  const nativeMenuHooks = [];
  const originalLang = document.documentElement.getAttribute('lang');
  const textExcluded = 'script,style,noscript,pre,code,kbd,samp,svg,canvas,iframe,webview,input,textarea,[contenteditable]:not([contenteditable="false"]),.monaco-editor,.xterm,.cm-editor,[data-ch-keep]';
  const authored = '[role="article"],[data-testid="user-input-step"],[data-testid="turn-cards-container"],[aria-label="User message"],[aria-label="Agent response"],.leading-relaxed.select-text';
  const named = '[data-testid="conversation-row-sidebar"],[data-testid="project-header"],[data-testid="breadcrumb-segment"],[data-testid="settings-nav-item-Account"]';
  // These strings belong to the application's progress/transition renderer.
  // Changing them after its width measurements makes the native animation flicker.
  const liveStatus = '[data-testid="agent-loading"],[data-testid="tool-group-collapsible"],.animate-shimmer-text,[data-slot],[data-slot-in],[data-slot-out],[data-testid="side-question-answer"] .animate-pulse,span[class~="!text-clip"]';
  const hardExcluded = `${liveStatus},script,style,svg,iframe,webview,pre,code,.monaco-editor,.xterm,.cm-editor,[data-ch-keep],[data-testid="project-header"],[data-testid="breadcrumb-segment"],[data-testid="settings-nav-item-Account"]`;
  const projectPlaceholders = new Set(['No Project','Select Project','Select Workspace','New Workspace']);
  const generatedControl = '[data-testid="worked-for-collapsible"],[data-testid="thinking-collapsible-trigger"],[data-testid="turn-cards-container"] .files-changed-header';
  // The app also reads aria-label as an operation key (e.g. Cancel on blur).
  // Preserve that contract and translate only display text and display attributes.
  const attrs = ['title', 'placeholder', 'data-placeholder', 'aria-placeholder', 'alt'];
  const attrSelector = attrs.map(a => `[${a}]`).join(',');
  const protectedCandidates = `${generatedControl},button,${attrSelector}`;
  const observation = {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:[...attrs,'data-context-window','data-cascade-id']};
  const parentMessageButton = el => {const button=el.closest('button');const text=button?.textContent.trim();return Boolean(button && (text==='Message from Parent Agent' || text===strings['Message from Parent Agent']));};
  const inLiveStatus = node => (node?.nodeType===Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(liveStatus);

  function textAllowed(el) {
    if (!el || inLiveStatus(el) || el.closest(textExcluded) || el.closest(named)) return false;
    if (el.closest(authored)) return Boolean(el.closest(generatedControl)) || parentMessageButton(el);
    // Tool output, terminal panes and diffs contain user files and commands.
    if (el.closest('[data-testid*="terminal-output"],[data-testid*="diff-content"],[data-testid*="file-content"]')) return false;
    return true;
  }
  function attrAllowed(el, attr) {
    if (inLiveStatus(el)) return false;
    if (el.closest('script,style,svg,iframe,webview,pre,code,.monaco-editor,.xterm,.cm-editor,[data-ch-keep]')) return false;
    if (el.closest('[data-testid="project-header"],[data-testid="breadcrumb-segment"],[data-testid="settings-nav-item-Account"]')) return false;
    if (el.closest('[data-testid="conversation-row-sidebar"]') && el.tagName==='A') return false;
    if (el.closest(authored) && !el.matches('button,[role="button"]')) return false;
    if (el.closest('[contenteditable]:not([contenteditable="false"])') && !['data-placeholder','aria-placeholder'].includes(attr)) return false;
    return true;
  }
  function duration(value) {
    return value.replace(/\b(\d+)\s*(days?|hours?|minutes?|seconds?|d|h|m|s)\b/g, (_,n,unit) => `${n}${({d:'天',day:'天',days:'天',h:'小时',hour:'小时',hours:'小时',m:'分钟',minute:'分钟',minutes:'分钟',s:'秒',second:'秒',seconds:'秒'})[unit]}`).replace(/,\s*|\s+and\s+/g,' ');
  }
  function translate(raw) {
    const originalValue = raw.trim();
    const value = originalValue.replace(/\s+/g, ' ');
    if (!value) return null;
    let translated = Object.prototype.hasOwnProperty.call(strings, value) ? strings[value] : null;
    if (!translated) {
      const dynamic = [
        [/^Worked for (\d[\d\w .]*)$/, m => `耗时 ${duration(m[1])}`],
        [/^Thought for (\d[\d\w .]*)$/, m => `已思考 ${duration(m[1])}`],
        [/^(\d+) files? changed$/, m => `${m[1]} 个文件已更改`],
        [/^(\d+)(mo|y) ago$/, m => `${m[1]}${m[2]==='mo'?'个月':'年'}前`],
        [/^(\d+\s*(?:days?|hours?|minutes?|seconds?|d|h|m|s)) ago$/, m => `${duration(m[1])}前`],
        [/^Select model, current: (.+)$/, m => `选择模型，当前：${m[1]}`],
        [/^Select project, current: (.+)$/, m => `选择项目，当前：${projectPlaceholders.has(m[1])?(strings[m[1]]||m[1]):m[1]}`],
        [/^Agent permissions preset selector, current: (.+)$/, m => `选择智能体权限预设，当前：${m[1]}`],
        [/^Load older messages, showing (\d+) of (\d+)$/, m => `加载更早的消息，已显示 ${m[1]} / ${m[2]}`],
        [/^Cancel \((.+)\)$/, m => `取消（${m[1]}）`],
        [/^You have used some of your weekly limit, it will fully refresh in (.+)\.$/, m => `本周额度已使用一部分，将在 ${duration(m[1])}后全部恢复。`],
        [/^You have used some of your 5-hour limit, it will fully refresh in (.+)\.$/, m => `5 小时额度已使用一部分，将在 ${duration(m[1])}后全部恢复。`],
        [/^Resets in (.+)$/, m => `${duration(m[1])}后恢复`],
        [/^Updated (.+)$/, m => `更新于 ${duration(m[1])}`],
      ];
      for (const [pattern, render] of dynamic) { const m = value.match(pattern); if (m) { translated = render(m); break; } }
    }
    return translated && translated !== value ? raw.slice(0, raw.indexOf(originalValue)) + translated + raw.slice(raw.indexOf(originalValue) + originalValue.length) : null;
  }
  function translatedMenu(items) {
    if(!Array.isArray(items))return items;
    return items.map(item=>{
      if(!item || typeof item!=='object')return item;
      const next={...item};
      if(typeof next.label==='string')next.label=translate(next.label)||next.label;
      if(Array.isArray(next.items))next.items=translatedMenu(next.items);
      if(Array.isArray(next.submenu))next.submenu=translatedMenu(next.submenu);
      return next;
    });
  }
  function installNativeMenuHooks() {
    // Find the UI's native-menu dispatch boundary by behavior, not its minified name.
    // Keep IDs, callbacks and menu actions intact; only clone and translate labels.
    for(const key of Object.getOwnPropertyNames(window)) {
      const descriptor=Object.getOwnPropertyDescriptor(window,key);
      if(!descriptor?.writable || typeof descriptor.value!=='function')continue;
      const original=descriptor.value;
      const source=Function.prototype.toString.call(original);
      if(source.includes('window.electronNative') && /\.showContextMenu(?:\?\.)?\(/.test(source)) {
        const wrapper=function(items,...args){return original.call(this,translatedMenu(items),...args);};
        window[key]=wrapper;
        nativeMenuHooks.push({key,original,wrapper,kind:'menu'});
      }
      // Translate the application's built-in automation template before it becomes
      // an editor draft. The exact default is the boundary: arbitrary input is untouched.
      const defaultText='Guide me through creating an automated task';
      const defaultPrompt=`[/automation](slashCommand;automation) ${defaultText}`;
      if(source.includes(defaultPrompt) && source.includes('useCallback')) {
        const parseCall=source.match(/=>\{var\s+[\w$]+=([\w$]+)\([\w$]+\);/);
        const parserKey=parseCall?.[1];
        const parserDescriptor=parserKey&&Object.getOwnPropertyDescriptor(window,parserKey);
        if(parserDescriptor?.writable && typeof parserDescriptor.value==='function' && !nativeMenuHooks.some(h=>h.key===parserKey)) {
          const parser=parserDescriptor.value;
          const wrapper=function(input,...args){
            const replacement=strings[defaultText];
            if(input===defaultPrompt && typeof replacement==='string')input=`[/automation](slashCommand;automation) ${replacement}`;
            return parser.call(this,input,...args);
          };
          window[parserKey]=wrapper;
          nativeMenuHooks.push({key:parserKey,original:parser,wrapper,kind:'default-prompt'});
        }
      }
    }
  }
  function patchText(node) {
    if (!textAllowed(node.parentElement)) return;
    if(node.parentElement.closest('[data-testid="project-selector-trigger"]') && !projectPlaceholders.has(node.data.trim())) return;
    const previous = texts.get(node);
    if (previous && node.data === previous.translated) return;
    const translated = translate(node.data);
    if (!translated) { texts.delete(node); return; }
    texts.set(node, {original:node.data, translated});
    node.data = translated;
  }
  function patchAttributes(el, names = attrs) {
    let record = attributes.get(el);
    for (const attr of names) {
      if (!el.hasAttribute(attr)) {
        record?.delete(attr);
        continue;
      }
      if (!attrAllowed(el, attr)) continue;
      const current = el.getAttribute(attr);
      if (record?.get(attr)?.translated === current) continue;
      const translated = translate(current);
      if (!translated) { record?.delete(attr); continue; }
      if (!record) { record=new Map();attributes.set(el,record); }
      record.set(attr, {original:current, translated});
      el.setAttribute(attr,translated);
    }
    if(record?.size===0)attributes.delete(el);
  }
  function covered(node, roots) {
    for (let parent=node; parent; parent=parent.parentNode) if(roots.has(parent))return true;
    return false;
  }
  function outerRoots(roots) {
    return [...roots].filter(root=>root.isConnected && !covered(root.parentNode,roots));
  }
  function queueAttribute(el, attr) {
    if (!attrAllowed(el,attr)) return;
    let names=pendingAttributes.get(el);
    if(!names){names=new Set();pendingAttributes.set(el,names);}
    names.add(attr);
  }
  // Protected content can contain UI islands. Find those once at the boundary,
  // rather than querying all descendants again for every blocked ancestor.
  function protectedTargets(root) {
    const roots=new Set(), elements=new Set();
    for(const el of [root,...root.querySelectorAll(protectedCandidates)]) {
      if(el.closest(hardExcluded))continue;
      if(textAllowed(el))roots.add(el);
      else if(attrs.some(attr=>el.hasAttribute(attr)&&attrAllowed(el,attr)))elements.add(el);
    }
    return {roots:new Set(outerRoots(roots)),elements};
  }
  function queueSubtree(node) {
    if(!node.isConnected)return;
    if(node.nodeType===Node.TEXT_NODE){if(textAllowed(node.parentElement))pendingTexts.add(node);return;}
    if(node.nodeType!==Node.ELEMENT_NODE || node.closest(hardExcluded))return;
    // Plain streamed leaf content has no UI islands to discover. Attributes on
    // inputs or protected buttons still use their own, smaller update queue.
    if(!node.firstElementChild && !textAllowed(node)) {
      for(const attr of attrs)if(node.hasAttribute(attr))queueAttribute(node,attr);
      return;
    }
    pendingRoots.add(node);
  }
  function scan(root) {
    if(!root?.isConnected || root.closest(hardExcluded))return;
    let node=root;
    while(node) {
      let descend=true;
      if(node.nodeType===Node.ELEMENT_NODE) {
        if(node.matches(contextRings.selector))contextRings.discover(node);
        if(node.matches(hardExcluded))descend=false;
        else if(!textAllowed(node)) {
          const targets=protectedTargets(node);
          for(const candidate of targets.roots)scan(candidate);
          for(const el of targets.elements)if(!covered(el,targets.roots))patchAttributes(el);
          descend=false;
        } else patchAttributes(node);
      } else if(node.nodeType===Node.TEXT_NODE)patchText(node);
      if(descend && node.firstChild){node=node.firstChild;continue;}
      while(node!==root && !node.nextSibling)node=node.parentNode;
      node=node===root?null:node.nextSibling;
    }
  }
  function scheduleCleanup() {
    if(cleanupTimer!==null || (!texts.size && !attributes.size && !contextRings.size))return;
    cleanupTimer=setTimeout(()=>{
      cleanupTimer=null;contextRings.cleanup();
      for(const node of texts.keys())if(!node.isConnected)texts.delete(node);
      for(const el of attributes.keys())if(!el.isConnected)attributes.delete(el);
    },1000);
  }
  function clearPending() {
    flushTask=null;pendingRoots.clear();pendingTexts.clear();pendingAttributes.clear();
  }
  function flush() {
    if(stopped) return;
    flushTask=null;
    // Other microtasks may have committed UI since our observer callback.
    // Preserve those records before disconnect() clears the observer queue.
    enqueueMutations(observer.takeRecords());
    observer.disconnect();
    try {
      const candidates=new Set();
      // Merge the raw additions before discovering protected UI islands too.
      for(const root of outerRoots(pendingRoots)) {
        if(root.closest(hardExcluded))continue;
        if(textAllowed(root)){candidates.add(root);continue;}
        const targets=protectedTargets(root);
        for(const candidate of targets.roots)candidates.add(candidate);
        for(const el of targets.elements)if(!covered(el,targets.roots))for(const attr of attrs)if(el.hasAttribute(attr))queueAttribute(el,attr);
      }
      const roots=new Set(outerRoots(candidates));
      for(const root of roots)scan(root);
      for(const node of pendingTexts)if(node.isConnected && !covered(node,roots))patchText(node);
      for(const [el,names] of pendingAttributes)if(el.isConnected && !covered(el,roots))patchAttributes(el,names);
      if(roots.size || pendingTexts.size || pendingAttributes.size)batches++;
      clearPending();
    } finally { if(!stopped) observer.observe(document.documentElement, observation); }
  }
  function enqueueMutations(mutations) {
    contextRings.mutations(mutations);
    for(const m of mutations) {
      if(m.type==='childList' && m.removedNodes.length)scheduleCleanup();
      if (inLiveStatus(m.target)) continue;
      if(m.type==='characterData'){if(textAllowed(m.target.parentElement))pendingTexts.add(m.target);}
      else if(m.type==='attributes'){if(attrs.includes(m.attributeName))queueAttribute(m.target,m.attributeName);}
      else if(!m.target.closest?.(hardExcluded))for(const n of m.addedNodes)queueSubtree(n);
    }
  }
  const observer=new MutationObserver(mutations=>{
    enqueueMutations(mutations);
    if((pendingRoots.size || pendingTexts.size || pendingAttributes.size) && flushTask===null) {
      // Coalesce commits within this microtask checkpoint, before the browser
      // paints. No fixed delay and no work while the UI is unchanged.
      const task=()=>{if(!stopped && flushTask===task)flush();};
      flushTask=task;
      queueMicrotask(task);
    }
  });
  function restore() {
    observer.disconnect();
    if(cleanupTimer!==null)clearTimeout(cleanupTimer);
    cleanupTimer=null;
    for(const [node,record] of texts) if(node.isConnected && node.data===record.translated) node.data=record.original;
    for(const [el,record] of attributes) if(el.isConnected) for(const [attr,value] of record) if(el.getAttribute(attr)===value.translated) el.setAttribute(attr,value.original);
    texts.clear();attributes.clear();
  }
  function collectUnknown() {
    const unknown=new Set();
    const candidates=document.querySelectorAll('button,[role="menuitem"],[role="option"],[role="tooltip"] *,[role="listbox"] *,[role="menu"] *,h1,h2,h3,label,.settings-modal-container p,.settings-modal-container span');
    for(const el of candidates) {
      if(!textAllowed(el) || el.closest('[data-testid="model-selector-trigger"],[data-testid="conversation-list-sidebar"] [data-testid="conversation-row-sidebar"]')) continue;
      for(const n of el.childNodes) if(n.nodeType===Node.TEXT_NODE) {
        const s=n.data.trim();
        if(s.length>2 && s.length<240 && /^[A-Z][A-Za-z ,.'’():!?&+\-]+$/.test(s) && !translate(s)) unknown.add(s);
      }
    }
    for(const el of document.querySelectorAll(attrSelector))for(const attr of attrs){
      const s=el.getAttribute(attr)?.trim();
      if(s && attrAllowed(el,attr) && s.length>2 && s.length<240 && /^[A-Z][A-Za-z ,.'’():!?&+\-]+$/.test(s) && !translate(s))unknown.add(s);
    }
    return [...unknown].sort();
  }
  const api={
    version:VERSION,
    status:()=>({version:VERSION,active:!stopped,textNodes:texts.size,attributes:[...attributes.values()].reduce((n,m)=>n+m.size,0),batches,entries:Object.keys(strings).length,nativeMenuAdapters:nativeMenuHooks.filter(h=>h.kind==='menu').length,defaultPromptAdapters:nativeMenuHooks.filter(h=>h.kind==='default-prompt').length,statusAdapters:statusFormatters?.count??0,contextUsage:contextRings.status()}),
    collectUnknown,
    refresh(next) { clearPending();restore();strings=next.strings||next;statusFormatters?.setStrings(strings);pendingRoots.add(document.body);flush();return api.status(); },
    uninstall() {
      stopped=true;clearPending();restore();contextRings.dispose();
      for(const hook of nativeMenuHooks){const owner=hook.owner||window;if(owner[hook.key]===hook.wrapper)owner[hook.key]=hook.original;}
      nativeMenuHooks.length=0;
      if(originalLang===null)document.documentElement.removeAttribute('lang');else document.documentElement.setAttribute('lang',originalLang);
      if(window.__antigravityChineseHelper===api)delete window.__antigravityChineseHelper;
      return {active:false};
    }
  };
  window.__antigravityChineseHelper=api;
  const start=()=>{if(stopped)return;installNativeMenuHooks();statusFormatters=installStatusFormatters({strings,register:(key,original,wrapper,kind,owner)=>nativeMenuHooks.push({key,original,wrapper,kind,owner})});document.documentElement.setAttribute('lang','zh-CN');pendingRoots.add(document.body);flush();};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  return api;
})
