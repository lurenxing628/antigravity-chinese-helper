(function installSwarmChinese(dictionary) {
  'use strict';
  const VERSION = '0.3.34';
  const doc = window.document;
  if (window.location?.protocol !== 'plugin:' || !/^swarm--swarm_board-\d+$/.test(window.location?.hostname || '') || window.location?.pathname !== '/' ||
    !window.sidecar || doc.getElementById('board')?.getAttribute('data-testid') !== 'swarm-board' ||
    !doc.getElementById('loading') || !doc.getElementById('empty')) return null;

  let strings, normalizedStrings, stopped = false, queued = false, snapshot = null;
  const textRecords = new Map(), attributeRecords = new Map(), hiveHooks = [];
  const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
  const normalize = value => value.trim().replace(/\s+/g,' ').replace(/[‘’]/g,"'").replace(/[“”]/g,'"');
  const setStrings = value => {
    strings = value?.strings || value || {};
    normalizedStrings = new Map(Object.entries(strings).map(([key,text]) => [normalize(key),text]));
  };
  setStrings(dictionary);
  function phrase(key, values = {}, original = key) {
    const name = 'swarm-ui:'+key;
    const translated = own(strings,name) ? strings[name] : normalizedStrings.get('swarm-ui:'+normalize(key));
    return typeof translated === 'string' ? translated.replace(/\{([a-zA-Z]+)\}/g,(token,name) =>
      own(values,name) ? String(values[name]) : token) : original;
  }
  const exact = raw => phrase(raw,{},raw);
  function whole(raw, project) {
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    const next = project(trimmed);
    return next === trimmed ? raw : raw.slice(0,raw.indexOf(trimmed))+next+raw.slice(raw.indexOf(trimmed)+trimmed.length);
  }
  function template(raw, pattern, key, names) {
    const match = pattern.exec(raw);
    if (!match) return raw;
    return phrase(key,Object.fromEntries(names.map((name,index) => [name,match[index+1]])),raw);
  }
  function duration(raw) {
    for (const [pattern,key,names] of [
      [/^(\d+)s$/,'{seconds}s',['seconds']],
      [/^(\d+)m (\d+)s$/,'{minutes}m {seconds}s',['minutes','seconds']],
      [/^(\d+)h (\d+)m$/,'{hours}h {minutes}m',['hours','minutes']]
    ]) { const next = template(raw,pattern,key,names); if (next !== raw) return next; }
    return raw;
  }
  function elapsed(raw) {
    const match = /^(.+) ago$/.exec(raw);
    return match ? phrase('{duration} ago',{duration:duration(match[1])},raw) : duration(raw);
  }
  function ui(raw) {
    const keys = { 'The team':'team',Coordinator:'lead',Blocked:'blocked',Running:'running','Planned next':'planned',Done:'done',
      Goal:'goal',Threads:'threads',Now:'now',Progress:'progress','Compare with now':'compare','Open full timeline':'expand',
      'Nothing blocked':'none_blocked','Nothing running':'none_running','Nothing planned':'none_planned',Reply:'reply',Open:'open' };
    const custom = window.SwarmHive?.viewCopy?.ui;
    if (custom && own(keys,raw) && custom[keys[raw]]) return raw;
    if (/^\+\d+ more$/.test(raw)) return custom?.more ? raw : template(raw,/^\+(\d+) more$/,'+{count} more',['count']);
    return exact(raw);
  }
  const members = () => Array.isArray(snapshot?.members) ? snapshot.members : [];
  const messages = () => Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const nativeRole = member => member.role && member.role !== 'worker' ? member.role :
    /^(narrator|monitor)(?:-\d+)?$/.exec(member.name || '')?.[1] || member.role || '';
  // Hive derives its last posts and briefs from this same non-system board.
  const boardMessages = () => messages().filter(message => {
    const member = members().find(value => value.name === message.agent);
    return !member?.roleWorker && !member?.narrator && !(message.control && typeof message.control === 'object');
  });
  function titleSources() {
    const value = snapshot?.view?.json;
    const view = value && typeof value === 'object' ? value : null;
    const plan = !view && snapshot?.plan && typeof snapshot.plan === 'object' ? snapshot.plan : null;
    const workstreams = Array.isArray(view?.workstreams) ? view.workstreams.filter(item => item?.title) : [];
    return {view,plan,workstreams};
  }
  function hasCoordinatorBrief(name) {
    const lead = members().find(member => member.role === 'coordinator')?.name;
    const match = new RegExp('^@'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b');
    const post = boardMessages().find(message => message.agent === lead && match.test(String(message.text || '')));
    if (!post) return false;
    // Presence of an @mention alone is not a title: Hive removes these brief
    // introductions before choosing its missing-title fallback.
    let text = String(post.text).replace(/^@\S+[\s,:]*/,'').replace(/\*\*([^*]+)\*\*/g,'$1').split(/(?<=[.!?])\s|\n/)[0];
    text = text.replace(/\s*\((?:you\b|your\b)[^)]*\)/gi,'').replace(/\s*\((?:you\b|your\b)[^)]*$/gi,'')
      .replace(/^(?:you\s+(?:are|own|handle|drive|run|lead|manage)|your\s+(?:role|job|task|assignment|goal|focus)\s+is(?:\s+to)?|assignment\s*:|role\s*:|task\s*:)\s*/i,'')
      .replace(/^(?:the|a|an|this\s+swarm's)\s+/i,'');
    return Boolean(text.replace(/\s+/g,' ').trim().replace(/[,;:.]+$/,''));
  }
  const memberName = name => name === 'coordinator' && members().some(member => member.name === name && member.role === 'coordinator')
    ? exact('coordinator') : name;
  const memberLabel = raw => raw.startsWith('@') ? '@'+memberName(raw.slice(1)) : memberName(raw);
  function nativeAttribute(element,name) {
    const current = element?.getAttribute(name), record = element && attributeRecords.get(element)?.get(name);
    return record && current === record.translated ? record.original : current;
  }
  function taskOwner(element) {
    const row = element.closest('.o2-runrow,li,.o2-card');
    const badge = row?.querySelector('.o2-wchip'), who = row?.querySelector('.o2-who')?.childNodes?.[0];
    const record = who && textRecords.get(who);
    const name = nativeAttribute(badge,'title')?.slice(1) ||
      (record && who.data === record.translated ? record.original : who?.data)?.trim().replace(/^@/,'');
    return name === 'coordinator' ? members().find(member => member.role === 'coordinator')?.name || name : name;
  }
  function memberText(raw,name) {
    const member = members().find(value => value.name === name);
    const hasActivity = member?.status === 'working' && member.activity;
    if (raw === 'No posts yet' && member && !hasActivity &&
      !boardMessages().some(message => message.agent === name)) return exact(raw);
    return member?.status === 'working' && member.activityKind === 'tool' && raw === member.activity &&
      ['Waiting for posts','Reading the board','Posting to the board'].includes(raw) ? exact(raw) : raw;
  }
  function hasSuppliedMemberTitle(name) {
    if (!snapshot) return true;
    const {plan,workstreams} = titleSources(), task = plan?.tasks?.[name];
    return Boolean(typeof task === 'string' && task.trim()) ||
      workstreams.some(item => item.owners?.includes(name)) || hasCoordinatorBrief(name);
  }
  function isFallbackTask(name) {
    return Boolean(snapshot && name && !titleSources().workstreams.length && !hasSuppliedMemberTitle(name));
  }
  function systemAlert(raw, name) {
    if (snapshot?.view?.json?.attention?.some(item => item?.why === raw || item?.short?.line === raw) ||
      snapshot?.view?.json?.workstreams?.some(item => item?.note === raw || item?.short?.line === raw)) return raw;
    for (const item of snapshot?.systemAttention || []) {
      if (name && item.member !== name) continue;
      const custom = window.SwarmHive?.viewCopy?.items?.[item.id];
      if (custom?.title || custom?.line) continue;
      const key = item.kind === 'quota' ? '@{name} ran out of quota' : item.kind === 'stuck' ? '@{name} looks stuck' : '@{name} hit an error';
      const title = key.replace('{name}',() => item.member);
      const detail = text => {
        const source = item.member+': last step failed';
        if (text === source && item.text === source+' ('+(item.kind === 'quota' ? 'quota' : 'error')+')')
          return phrase('{name}: last step failed',{name:item.member},text);
        return item.kind === 'stuck' && text === item.text ? systemText(text) : text;
      };
      if (raw === title) return phrase(key,{name:item.member},raw);
      if (raw.startsWith(title+' — ')) return phrase(key,{name:item.member},title)+' — '+detail(raw.slice(title.length+3));
      if (raw === item.member+': last step failed' || (item.kind === 'stuck' && raw === item.text)) return detail(raw);
    }
    return raw;
  }
  function taskText(raw, element) {
    if (!snapshot) return raw;
    const supplied = snapshot.view?.json;
    if (supplied?.attention?.some(item => item?.title === raw || item?.short?.title === raw) ||
      supplied?.workstreams?.some(item => item?.title === raw || item?.short?.title === raw)) return raw;
    // These titles are data. Only the source's proven missing-title fallback is UI.
    if (raw === 'Task') {
      if (isFallbackTask(taskOwner(element))) return exact(raw);
    }
    return systemAlert(raw);
  }
  function taskNote(raw, element) {
    const notice = systemAlert(raw);
    if (notice !== raw) return notice;
    if (!snapshot || titleSources().workstreams.length) return raw;
    const name = taskOwner(element);
    if (window.SwarmHive?.viewCopy?.items?.[name]?.line ||
      snapshot.view?.json?.workstreams?.some(item => item?.id === name && item.short?.line) ||
      snapshot.view?.json?.attention?.some(item => item?.id === name && item.short?.line)) return raw;
    return memberText(raw,name);
  }
  function memberStatus(raw, element) {
    const row = element.closest('.o2-mrow');
    if (raw.startsWith('→ @')) return '→ '+memberLabel(raw.slice(2));
    if (row?.matches('.coord') || element.matches('.info,.warn')) return exact(raw);
    const name = row?.getAttribute('data-open-member');
    const member = members().find(value => value.name === name);
    if (raw === 'Retired' && member?.killed && !hasSuppliedMemberTitle(name)) return exact(raw);
    return raw === 'Task' && isFallbackTask(name) ? exact(raw) : raw;
  }
  function memberNow(raw, element) {
    const name = element.closest('.o2-mrow')?.getAttribute('data-open-member');
    const member = members().find(value => value.name === name);
    const owned = memberText(raw,name);
    if (owned !== raw) return owned;
    return member ? systemAlert(raw,name) : raw;
  }
  function leadNow(raw) {
    if (window.SwarmHive?.viewCopy?.lead?.doing) return raw;
    const lead = members().find(member => member.role === 'coordinator');
    return lead ? memberText(raw,lead.name) : raw;
  }
  function headlineFallback(raw, element) {
    if (!snapshot || !['Waiting for the first post.','Waiting for the first post'].includes(raw)) return raw;
    const {view,plan} = titleSources(), goal = view?.goal || plan?.goal;
    if (view?.headline || plan?.goal?.line || boardMessages().length) return raw;
    if (element.matches('.o2-goal > b') && goal?.title) return raw;
    // Running summaries prefer an explicit summary, then the headline unless
    // the goal already contains it. A different goal does not own this fallback.
    if (element.matches('.o2-runsum') && (view?.running_summary ||
      goal?.title === 'Waiting for the first post.' || goal?.line === 'Waiting for the first post.')) return raw;
    return exact(raw);
  }
  function threadTitle(raw, element) {
    if (!snapshot) return raw;
    const id = element.closest('[data-o2t]')?.getAttribute('data-o2t');
    const {view,plan} = titleSources();
    if (!['t-asks','t-other'].includes(id) || view?.threads?.some(thread => thread.id === id) ||
      plan?.threads?.some(thread => thread.id === id)) return raw;
    return ['Needs you','Other','Tasks'].includes(raw) ? exact(raw) : raw;
  }
  function sourceText(raw) {
    let next = template(raw,/^([\s\S]+) · (\d+) machines?$/,'{source} · {count} machines',['source','count']);
    if (next === raw) next = template(raw,/^([\s\S]+) · (reconnecting|connecting|unavailable)$/,'{source} · {status}',['source','status']);
    if (next !== raw && snapshot?.source && !snapshot.source.label) next = next.replace('Remote',() => exact('Remote'));
    // Status is a native enum in this slot, while the source label is data.
    if (/ · (reconnecting|connecting|unavailable)$/.test(raw)) {
      const match = /^([\s\S]+) · (reconnecting|connecting|unavailable)$/.exec(raw);
      return phrase('{source} · {status}',{source:snapshot?.source && !snapshot.source.label ? exact('Remote') : match[1],status:exact(match[2])},raw);
    }
    return next;
  }
  function sourceError(raw) {
    const missing = /^board CLI not found \(([\s\S]*)\)(?:; set ([\s\S]+))?$/.exec(raw);
    if (missing) return phrase('board CLI not found ({command})',{command:missing[1]},'board CLI not found ('+missing[1]+')')+
      (missing[2] ? phrase('; set {variable}',{variable:missing[2]},'; set '+missing[2]) : '');
    const exited = /^swarm watcher exited \(([\s\S]+)\)$/.exec(raw);
    return exited ? phrase('swarm watcher exited ({reason})',{reason:exited[1]},raw) :
      raw === 'swarm watcher exited' ? exact(raw) : raw;
  }
  function sourceTip(raw) {
    const match = /^Shared ([^\n]+) board ([^\n]*)([\s\S]*)$/.exec(raw);
    if (!match) return raw;
    const label = snapshot?.source && !snapshot.source.label ? exact('Remote') : match[1];
    let rest = match[3];
    const error = snapshot?.source?.error;
    if (error && rest.endsWith('\nError: '+error)) rest = rest.slice(0,-('\nError: '+error).length)+'\n'+phrase('Error: {detail}',{detail:sourceError(error)},'Error: '+error);
    return phrase('Shared {source} board {id}',{source:label,id:match[2]},'Shared '+match[1]+' board '+match[2])+rest;
  }
  function memberMeta(raw, element) {
    const name = element.closest('.o2-mrow')?.getAttribute('data-open-member');
    const member = members().find(value => value.name === name);
    if (!member?.posts || boardMessages().some(message => message.agent === name)) return raw;
    const match = /^(.*?)(\d+) posts?$/.exec(raw);
    return match && Number(match[2]) === member.posts ? match[1]+phrase('{count} posts',{count:match[2]},match[2]+' posts') : raw;
  }
  function chipName(raw, element) {
    const name = element.closest('[data-agent]')?.getAttribute('data-agent');
    return name && raw === name+' (you)' ? phrase('{name} (you)',{name:memberName(name)},raw) : raw === name ? memberName(name) : raw;
  }
  function chipTip(raw, element) {
    const name = element.getAttribute('data-agent');
    const member = members().find(value => value.name === name);
    const match = /^([\s\S]+) · (Active|Waiting|Killed) · (\d+) posts?\n(Hidden from the board; click to show|Click to hide from the board)$/.exec(raw);
    if (!match) return raw;
    let prefix = match[1];
    if (member) {
      const role = nativeRole(member), suffix = ' · '+role+(member.model ? ' · '+member.model : '');
      if (prefix.endsWith(suffix)) prefix = prefix.slice(0,-suffix.length)+' · '+exact(role)+(member.model ? ' · '+member.model : '');
    }
    if (name && prefix.startsWith(name+' (you)')) prefix = phrase('{name} (you)',{name:memberName(name)},name+' (you)')+prefix.slice((name+' (you)').length);
    else if (name && (prefix === name || prefix.startsWith(name+' · '))) prefix = memberName(name)+prefix.slice(name.length);
    return prefix+' · '+exact(match[2])+' · '+phrase('{count} posts',{count:match[3]},match[3]+' posts')+'\n'+exact(match[4]);
  }
  function graphTip(raw, element) {
    const direct = /^([\s\S]+) → ([\s\S]+): (\d+) direct$/.exec(raw);
    const edge = /^([\s\S]+) → ([\s\S]+): (\d+) direct, (\d+) via @all$/.exec(raw);
    if (edge) return phrase('{from} → {to}: {direct} direct, {broadcast} via @all',{from:memberName(edge[1]),to:memberName(edge[2]),direct:edge[3],broadcast:edge[4]},raw);
    if (direct) return phrase('{from} → {to}: {count} direct',{from:memberName(direct[1]),to:memberName(direct[2]),count:direct[3]},raw);
    const conv = element.parentElement?.getAttribute('data-conv');
    const member = members().find(value => value.conversation_id === conv);
    if (!member) return template(raw,/^([\s\S]+) \(not on the roster\)$/,'{name} (not on the roster)',['name']);
    if (typeof member.role !== 'string') return raw;
    const prefix = member.name+' · '+member.role+(member.model ? ' · '+member.model : '')+' · ';
    if (!raw.startsWith(prefix)) return raw;
    const match = /^(Active|Waiting|Killed|) · (\d+) steps · (\d+) posts · (\d+) unread([\s\S]*)$/.exec(raw.slice(prefix.length));
    if (!match) return raw;
    let tail = match[5];
    tail = tail.replace(/^ · (\d+) unaddressed/,(_,count) => ' · '+phrase('{count} unaddressed',{count},count+' unaddressed'));
    if (member.owner?.label) tail = tail.replace('\non '+member.owner.label,() => '\n'+phrase('on {machine}',{machine:member.owner.label},'on '+member.owner.label));
    if (tail.endsWith('\nClick to open conversation')) tail = tail.slice(0,-'\nClick to open conversation'.length)+'\n'+exact('Click to open conversation');
    return memberName(member.name)+' · '+exact(member.role)+(member.model ? ' · '+member.model : '')+' · '+exact(match[1])+' · '+
      phrase('{steps} steps · {posts} posts · {unread} unread',{steps:match[2],posts:match[3],unread:match[4]},match[2]+' steps · '+match[3]+' posts · '+match[4]+' unread')+tail;
  }
  function filterOption(raw, element) {
    const value = element.getAttribute('value') ?? '';
    const id = element.parentElement?.id;
    if (!value || ['@none','@all'].includes(value)) return exact(raw);
    if (id === 'f-channel' && value === 'main' && raw === '#main') return '#'+exact('main');
    if (id === 'f-agent' && raw === 'From '+value) return phrase('From {name}',{name:memberName(value)},raw);
    if (id === 'f-mention' && raw === 'To '+value) return phrase('To {name}',{name:memberName(value)},raw);
    return id === 'f-channel' && raw === '#'+value+' (archived)' ? phrase('#{channel} (archived)',{channel:value},raw) : raw;
  }
  function channelTip(raw) {
    for (const [pattern,key,names] of [
      [/^#([\s\S]+) is archived: this addresses nobody$/,'#{channel} is archived: this addresses nobody',['channel']],
      [/^Everyone in #([\s\S]+)$/,'Everyone in #{channel}',['channel']],
      [/^Posted in #([\s\S]+); click to show only #\1$/,'Posted in #{channel}; click to show only #{channel}',['channel']]
    ]) { const next = template(raw,pattern,key,names); if (next !== raw) return next; }
    if (raw === 'main: the whole swarm reads it' || raw === 'Posts in every channel') return exact(raw);
    const lines = raw.split('\n');
    return lines.map((line,index) => index && line.startsWith('created by ') ? phrase('created by {name}',{name:line.slice(11)},line) :
      index && line === 'archived' ? exact(line) : line).join('\n');
  }
  function frameReason(raw) {
    if (raw.startsWith('error: ')) return phrase('error: {detail}',{detail:raw.slice(7)},raw);
    return template(raw,/^no (READY|RENDERED) within (\d+)s$/,'no {event} within {seconds}s',['event','seconds']) !== raw
      ? template(raw,/^no (READY|RENDERED) within (\d+)s$/,'no {event} within {seconds}s',['event','seconds']) : exact(raw);
  }
  function overviewText(raw) {
    let match = /^paused: (quota|error)$/.exec(raw);
    if (match) return phrase('paused: {reason}',{reason:exact(match[1])},raw);
    match = /^read #(\d+)(?: · updated (.+))?$/.exec(raw);
    if (match) return phrase('read #{sequence}',{sequence:match[1]},'read #'+match[1])+
      (match[2] ? ' · '+phrase('updated {time}',{time:elapsed(match[2])},'updated '+match[2]) : '');
    match = /^Last change: “([\s\S]*)”$/.exec(raw);
    if (match) return phrase('Last change: “{text}”',{text:match[1]},raw);
    const prefix = "overview · from the narrator's notes";
    if (raw.startsWith(prefix+' · ')) {
      let reason = raw.slice(prefix.length+3);
      const failure = /^the narrator's view failed \(([\s\S]*)\)$/.exec(reason);
      reason = failure ? phrase("the narrator's view failed ({reason})",{reason:frameReason(failure[1])},reason) : exact(reason);
      return exact(prefix)+' · '+reason;
    }
    return exact(raw);
  }
  function overviewTip(raw) {
    let next = template(raw,/^The narrator's last step failed: ([\s\S]*)$/,"The narrator's last step failed: {detail}",['detail']);
    if (next !== raw) return next;
    next = template(raw,/^(\d+) posts? since the view was updated$/,'{count} posts since the view was updated',['count']);
    if (next !== raw) return next;
    return template(raw,/^Narrator read up to #(\d+) of (\d+)$/,'Narrator read up to #{read} of {total}',['read','total']) !== raw
      ? template(raw,/^Narrator read up to #(\d+) of (\d+)$/,'Narrator read up to #{read} of {total}',['read','total']) : exact(raw);
  }
  function systemText(raw) {
    const failed = /^([\s\S]+): last step failed \((quota|error)\)$/.exec(raw);
    if (failed) return phrase('{name}: last step failed ({reason})',{name:failed[1],reason:exact(failed[2])},raw);
    const stuck = /^([\s\S]+): no progress, and not waiting on the board(?: for ([\dhms ]+))?$/.exec(raw);
    if (stuck) return phrase('{name}: no progress, and not waiting on the board',{name:stuck[1]},stuck[1]+': no progress, and not waiting on the board')+
      (stuck[2] ? phrase(' for {duration}',{duration:duration(stuck[2])},' for '+stuck[2]) : '');
    return raw;
  }
  function toastText(raw) {
    const remote = members().find(member => member.local === false && raw === `${member.name} runs on ${member.owner?.label || 'another machine'}; open it there.`);
    if (remote) return phrase('{name} runs on {machine}; open it there.',{name:remote.name,machine:remote.owner?.label || exact('another machine')},raw);
    for (const [pattern,key,names] of [
      [/^Copied "([\s\S]*)"\. Paste it in the chat\.$/,'Copied "{text}". Paste it in the chat.',['text']],
      [/^Type "([\s\S]*)" in the chat\.$/,'Type "{text}" in the chat.',['text']],
      [/^Opening ([\s\S]*)'s conversation needs the app\.$/,"Opening {name}'s conversation needs the app.",['name']],
      [/^Copied “([\s\S]*)”\. Paste it to the coordinator and say what you want changed\.$/,'Copied “{text}”. Paste it to the coordinator and say what you want changed.',['text']],
      [/^Tell the coordinator: “([\s\S]*) …”$/,'Tell the coordinator: “{text} …”',['text']],
      [/^Copied “([\s\S]*)”\. Paste it to the coordinator on ([\s\S]*)\.$/,'Copied “{text}”. Paste it to the coordinator on {machine}.',['text','machine']],
      [/^Tell it “([\s\S]*) …” to the coordinator on ([\s\S]*)\.$/,'Tell it “{text} …” to the coordinator on {machine}.',['text','machine']]
    ]) {
      const match = pattern.exec(raw);
      if (!match) continue;
      const values = Object.fromEntries(names.map((name,index) => [name,match[index+1]]));
      const lead = members().find(member => member.role === 'coordinator');
      if (values.machine === 'its machine' && lead?.local === false && !lead.owner?.label) values.machine = exact('its machine');
      const next = phrase(key,values,raw);
      if (next !== raw) return next;
    }
    return exact(raw);
  }
  function countText(raw) {
    if (raw.startsWith('Now · ') && window.SwarmHive?.viewCopy?.ui?.now) return raw;
    for (const [pattern,key,names] of [
      [/^(\d+) of (\d+)$/,'{done} of {total}',['done','total']],
      [/^(\d+) of (\d+) tasks done$/,'{done} of {total} tasks done',['done','total']],
      [/^(\d+) needs? you$/,'{count} need you',['count']],
      [/^(\d+) blocked$/,'{count} blocked',['count']],
      [/^(\d+) threads? open$/,'{count} threads open',['count']],
      [/^(\d+) active$/,'{count} active',['count']],
      [/^Up next · (\d+)$/,'Up next · {count}',['count']],
      [/^(\d+) posts?$/,'{count} posts',['count']],
      [/^Now · (\d+) \/ (\d+)$/,'Now · {index} / {total}',['index','total']],
      [/^last seen (\d+)([mhd]) ago$/,'last seen {count}{unit} ago',['count','unit']]
    ]) {
      if (key === 'last seen {count}{unit} ago') {
        const match = pattern.exec(raw);
        if (match) return phrase(key,{count:match[1],unit:exact({m:'minutes',h:'hours',d:'days'}[match[2]])},raw);
      } else { const next = template(raw,pattern,key,names); if (next !== raw) return next; }
    }
    return exact(raw);
  }
  function replayText(raw) {
    let match = /^over (.+)$/.exec(raw);
    if (match) return phrase('over {duration}',{duration:duration(match[1])},raw);
    match = /^of (\d+)(?: · #(\d+) at (.+) \(\+(.+)\))?$/.exec(raw);
    if (match) return phrase('of {total}',{total:match[1]},'of '+match[1])+(match[2] ? ' · '+
      phrase('#{sequence} at {time} (+{duration})',{sequence:match[2],time:match[3],duration:duration(match[4])},'#'+match[2]+' at '+match[3]+' (+'+match[4]+')') : '');
    return countText(raw);
  }
  function messageAria(raw,element) {
    const message = messages().find(value => String(value.seq) === element.getAttribute('data-seq'));
    if (!message) return raw;
    const recipients = (message.mentions || []).filter(name => name !== message.agent);
    const addressed = recipients.length || message.all;
    const prefix = message.agent+(addressed ? ' to '+[...recipients,...(message.all ? ['all'] : [])].join(', ') : '');
    const translated = addressed ? phrase('{name} to {recipients}',{
      name:memberName(message.agent),recipients:[...recipients.map(memberName),...(message.all ? [exact('all')] : [])].join(', ')
    },prefix) : memberName(message.agent);
    return raw.startsWith(prefix+', ') ? translated+raw.slice(prefix.length) : raw;
  }

  // Only native interface slots opt in. Names, prose, task titles, model names,
  // raw files, and the narrator's document never enter this selector list.
  const textRules = [];
  const texts = (selector,project = exact) => textRules.push({selector,project});
  texts('head > title,#loading .loading-caption,#live-label,#tabbtn-overview,#tabbtn-feed,#tabbtn-members,#tabbtn-graph,#tabbtn-raw,'+
    '#empty-title,#empty-body,.empty-hint,#ov-mode,#ov-footer .ov-hint > span,#ov-open-coord,#ov-system .ghost-btn,#ov-system .ov-sys-text > b,'+
    '#tab-feed .switch > span,#tab-graph .switch > span,#jump-latest,#replay-live,#replay-timing > option,.graph-legend > .legend-item,'+
    '#raw-copy-label,#feed .msg-more,#feed .msg-note,#feed .divider,#feed .feed-empty-title,#feed .feed-empty > div,#feed [data-clear-filters],'+
    '.o2-doneempty,.o2-tprog.rev,.o2-msec > span,.o2-mret > span,.o2-onb-h,.o2-onb-steps > li > div > b,.o2-onb-steps > li > div > span,'+
    '.o2-onb-wait .animate-shimmer-text,.o2-m.all > span,.o2-mtag[data-testid="swarm-member-channels"]');
  texts('#swarm-title',(raw) => snapshot && !snapshot.title && raw === 'Untitled swarm' ? exact(raw) : raw);
  texts('#f-agent > option,#f-mention > option,#f-channel > option',filterOption);
  texts('#channel-tabs [data-channel=""]',exact);
  texts('#channel-tabs [data-channel="main"]',raw => raw === '#main' ? '#'+exact('main') : raw);
  texts('#agents .chip-name',chipName);
  texts('#feed .msg-head .msg-author,#feed .msg-head .msg-to > span,'+
    '#replay-caption .msg-head .msg-author,#replay-caption .msg-head .msg-to > span',memberLabel);
  texts('#ov-label .ov-label-text,#ov-status .badge,#ov-status .ov-fresh,#ov-notice,#ov-ack',overviewText);
  texts('#ov-system .ov-sys-text',systemText);
  texts('#toast',toastText);
  texts('#replay-label,#replay-label > b',replayText);
  texts('#raw-meta .size',raw => template(raw,/^([\s\S]*?) · (\d+) lines?$/,'{size} · {count} lines',['size','count']));
  texts('#raw',raw => {
    const kind = doc.querySelector('.raw-btn.on')?.getAttribute('data-raw');
    return snapshot && kind && !snapshot.raw?.[kind] && raw === '(empty)' ? exact(raw) : raw;
  });
  texts('.o2-h,.o2-lb > b,.o2-runh > b,.o2-glbl,.o2-none,.o2-more,.o2-btn,.o2-rtag,.o2-thn > span,.o2-tvh > b',ui);
  texts('.o2-progt,.o2-progt > b,.o2-pchip,.o2-qhdr,.o2-rmeta,.o2-tvmeta,.o2-tvpos,[data-testid="swarm-member-seen"]',countText);
  texts('.o2-rcmp',raw => raw === 'Hide compare' ? exact(raw) : ui(raw));
  texts('.o2-src',sourceText);
  texts('.o2-mstat,.o2-mrole',memberStatus);
  texts('.o2-mts',memberMeta);
  texts('.o2-mnow',memberNow);
  texts('.o2-lb > p',leadNow);
  texts('.o2-mrow.coord .o2-mauth,.o2-who',raw => raw === '@coordinator' ? '@'+exact('coordinator') : raw);
  texts('.o2-wchip > span',(raw,element) => nativeAttribute(element.parentElement,'title') === '@coordinator' && raw === 'coordinator' ? exact('coordinator') : raw);
  texts('#graph .node .node-label',(raw,element) => {
    const conv = element.closest('.node')?.getAttribute('data-conv');
    const member = members().find(value => value.conversation_id === conv);
    const label = member && memberName(member.name);
    return member && label !== member.name && (raw === member.name || raw.endsWith('…') && member.name.startsWith(raw.slice(0,-1))) ? label : raw;
  });
  texts('.o2-goal > b,.o2-runsum',headlineFallback);
  texts('.o2-tht > em',exact);
  texts('.o2-tht > b',threadTitle);
  texts('.o2-runt,.o2-tt,.o2-donem > b,.o2-cb > b,.o2-ask > div > b',taskText);
  texts('.o2-donem > span,.o2-runnote,.o2-cb > p',taskNote);
  texts('.o2-ask > div > p',raw => systemAlert(raw));

  const attributeRules = [];
  const attrs = (selector,names = ['title','aria-label','placeholder'],project = exact) => attributeRules.push({selector,names,project});
  attrs('#live,#board > .header .tabs,#ov-system,#f-search,#f-toggle,#channel-tabs,#f-agent,#f-mention,#f-channel,#agents,'+
    '#tab-feed .switch,#tab-graph .switch,#tab-graph .btn-group,#replay-start,#replay-back,#replay-play,#replay-fwd,#replay-slider,#replay-live,'+
    '#replay-timing,#replay-speed,#graph,.raw-toolbar .segmented,#raw-copy,.o2-msin,.o2-crew,.o2-m.all,.o2-ti,.o2-rswipe,.o2-rscrub,'+
    '.o2-tvx,.o2-tvnav,.o2-tvstrip,#ov-frame > iframe');
  attrs('.o2-rexp,.o2-tv',['title','aria-label'],ui);
  attrs('#agents [data-agent]',['title'],chipTip);
  attrs('.o2-wchip',['title'],raw => raw === '@coordinator' ? '@'+exact('coordinator') : raw);
  attrs('#swarm-title',['title'],raw => {
    if (!snapshot) return raw;
    const name = snapshot.title || 'Untitled swarm', prefix = name+'\nswarm '+snapshot.id+'\n';
    return raw.startsWith(prefix) ? (snapshot.title ? name : exact(name))+'\n'+phrase('swarm {id}',{id:snapshot.id},'swarm '+snapshot.id)+'\n'+raw.slice(prefix.length) : raw;
  });
  attrs('#feed .msg',['aria-label'],messageAria);
  attrs('#feed .mention,#replay-caption .mention',['title'],raw => {
    const match = /^([\s\S]+) · (Active|Waiting|Killed)$/.exec(raw);
    return match ? phrase('{name} · {status}',{name:memberName(match[1]),status:exact(match[2])},raw) : raw;
  });
  attrs('#channel-tabs [data-channel],#feed .msg-channel,#feed .mention.channel,#replay-caption .mention.channel',['title'],channelTip);
  attrs('#feed .msg-author',['title'],exact);
  attrs('#feed .seq-ref,#replay-caption .seq-ref',['title'],raw => {
    const match = /^Go to #(\d+) \(([\s\S]*)\)$/.exec(raw);
    return match ? phrase('Go to #{sequence} ({name})',{sequence:match[1],name:memberName(match[2])},raw) :
      template(raw,/^Go to #(\d+)$/,'Go to #{sequence}',['sequence']);
  });
  attrs('#feed .msg-system .sys-text',['title'],(raw,element) => {
    const message = messages().find(value => String(value.seq) === element.closest('[data-seq]')?.getAttribute('data-seq'));
    const prefix = message && '#'+message.seq+' · '+message.agent+' · ';
    return prefix && raw.startsWith(prefix) ? '#'+message.seq+' · '+memberName(message.agent)+' · '+raw.slice(prefix.length) : raw;
  });
  texts('#graph title',graphTip);
  attrs('#ov-status .badge,#ov-status .ov-fresh',['title'],overviewTip);
  attrs('.o2-src',['title'],sourceTip);
  attrs('[data-testid="swarm-member-owner"]',['title'],raw => template(raw,/^Runs on ([\s\S]*)$/,'Runs on {machine}',['machine']));
  attrs('.o2-tprog',['title'],raw => template(raw,/^([\s\S]*) done$/,'{label} done',['label']));
  attrs('.o2-runnote',['title'],taskNote);

  function patchText(node,project,element) {
    const previous = textRecords.get(node), raw = previous && node.data === previous.translated ? previous.original : node.data;
    const translated = whole(raw,value => project(value,element));
    if (translated === raw) {
      if (previous && node.data === previous.translated) node.data = raw;
      textRecords.delete(node);
    } else {
      textRecords.set(node,{original:raw,translated});
      if (node.data !== translated) node.data = translated;
    }
  }
  function patchAttribute(element,name,project) {
    const current = element.getAttribute(name), record = attributeRecords.get(element), previous = record?.get(name);
    if (current === null) { record?.delete(name); return; }
    const raw = previous && current === previous.translated ? previous.original : current;
    const translated = project(raw,element);
    if (translated === raw) {
      if (previous && current === previous.translated) element.setAttribute(name,raw);
      record?.delete(name);
    } else {
      const next = record || new Map();
      next.set(name,{original:raw,translated}); attributeRecords.set(element,next);
      if (current !== translated) element.setAttribute(name,translated);
    }
  }
  function schedule() {
    if (stopped || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (!stopped) scan(); });
  }
  function hookHive() {
    const owner = window.SwarmHive;
    if (!owner || typeof owner.update !== 'function' || hiveHooks.some(hook => hook.wrapper === owner.update)) return;
    const original = owner.update;
    function updateSwarmDisplay(...args) {
      if (!stopped && Array.isArray(args[0]?.members) && Array.isArray(args[0]?.messages)) snapshot = args[0];
      const result = Reflect.apply(original,this,args);
      schedule();
      return result;
    }
    owner.update = updateSwarmDisplay;
    hiveHooks.push({owner,original,wrapper:updateSwarmDisplay});
  }
  function scan() {
    hookHive();
    const nodes = new Map(), attributes = new Map();
    for (const {selector,project} of textRules) for (const element of doc.querySelectorAll(selector))
      for (const node of element.childNodes) if (node.nodeType === 3) nodes.set(node,{element,project});
    for (const [node,{project,element}] of nodes) patchText(node,project,element);
    for (const {selector,names,project} of attributeRules) for (const element of doc.querySelectorAll(selector)) {
      const fields = attributes.get(element) || new Map();
      for (const name of names) fields.set(name,project);
      attributes.set(element,fields);
    }
    for (const [element,fields] of attributes) for (const [name,project] of fields) patchAttribute(element,name,project);
    for (const [node] of textRecords) if (!node.isConnected) textRecords.delete(node);
    for (const [element,record] of attributeRecords) if (!element.isConnected || !record.size) attributeRecords.delete(element);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(doc.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','placeholder']});
  const originalLang = doc.documentElement.getAttribute('lang');
  doc.documentElement.setAttribute('lang','zh-CN');
  scan();
  // A pane already open at installation may return unchanged polls forever.
  // Read its existing snapshot once; later native updates remain authoritative.
  const read = window.sidecar.fetch || window.fetch;
  if (typeof read === 'function') {
    const conv = window.sidecar.conversationId || (typeof URLSearchParams === 'function' ? new URLSearchParams(window.location.search || '').get('conversationId') : '') || '';
    const path = '/api/swarm'+(conv ? '?conversationId='+encodeURIComponent(conv) : '');
    Promise.resolve().then(() => stopped ? null : read.call(window.sidecar.fetch ? window.sidecar : window,path,{method:'GET'})).then(response => response?.ok ? response.json() : null).then(value => {
      if (!stopped && !snapshot && Array.isArray(value?.members) && Array.isArray(value?.messages)) { snapshot = value; schedule(); }
    }).catch(() => {});
  }
  return {
    version:VERSION,
    refresh(nextDictionary) { if (!stopped) { setStrings(nextDictionary); scan(); } },
    uninstall() {
      if (stopped) return;
      stopped = true; observer.disconnect();
      for (const [node,record] of textRecords) if (node.data === record.translated) node.data = record.original;
      for (const [element,record] of attributeRecords) for (const [name,value] of record)
        if (element.getAttribute(name) === value.translated) element.setAttribute(name,value.original);
      for (const hook of hiveHooks.reverse()) if (hook.owner.update === hook.wrapper) hook.owner.update = hook.original;
      if (doc.documentElement.getAttribute('lang') === 'zh-CN') originalLang === null
        ? doc.documentElement.removeAttribute('lang') : doc.documentElement.setAttribute('lang',originalLang);
      textRecords.clear(); attributeRecords.clear(); snapshot = null;
    }
  };
})
