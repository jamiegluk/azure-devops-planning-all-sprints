// ==UserScript==
// @name        Azure DevOps Planning All Sprints
// @namespace   https://github.com/jamiegluk
// @version     1.0.0
// @description Adds a "Show more" button to the Sprints › Planning pane in Azure DevOps that lists every remaining team sprint beyond the built-in limit.
// @author      Jamie Lievesley
// @license     MIT
// @match       https://dev.azure.com/*
// @match       https://*.visualstudio.com/*
// @run-at      document-idle
// @grant       none
// @homepageURL https://github.com/jamiegluk/azure-devops-planning-all-sprints
// @supportURL  https://github.com/jamiegluk/azure-devops-planning-all-sprints/issues
// @updateURL   https://raw.githubusercontent.com/jamiegluk/azure-devops-planning-all-sprints/master/azure-devops-planning-all-sprints.user.js
// @downloadURL https://raw.githubusercontent.com/jamiegluk/azure-devops-planning-all-sprints/master/azure-devops-planning-all-sprints.user.js
// ==/UserScript==

(() => {
  'use strict';

  const API = 'api-version=7.1';
  const ROOT_ID = 'ado-more-sprints';

  const state = {
    key: null,        // team context key; reset everything when it changes
    expanded: false,
    meta: null,       // Promise of static team/project config
    stats: null,      // Map(iterationId -> stats) for the extra sprints
    loading: false,
    error: null,
    nativeSig: '',
    fmt: null,
    refreshing: new Set(),     // iteration ids with a per-card refresh in flight
    refreshErrors: new Map(),  // iteration id -> last refresh error
  };

  // ---------- context ----------

  function getContext() {
    const host = location.hostname;
    const segs = location.pathname.split('/').filter(Boolean);
    let orgPrefix, rest;
    if (host === 'dev.azure.com') {
      orgPrefix = '/' + segs[0];
      rest = segs.slice(1);
    } else {
      orgPrefix = '';
      rest = segs;
    }
    // rest: [project, "_sprints", view, team, ...iterationPath]
    if (rest.length < 4 || rest[1] !== '_sprints') return null;
    const [project, , view, team] = rest;
    const projBase = location.origin + orgPrefix + '/' + project;
    return {
      key: projBase + '/' + team,
      projBase,
      teamBase: projBase + '/' + team,
      sprintsBase: projBase + '/_sprints/' + view + '/' + team,
    };
  }

  async function api(url, body) {
    const opts = {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' },
    };
    if (body) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + API, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status} – ${url.replace(location.origin, '')}`);
    return r.json();
  }

  // ---------- data ----------

  function loadMeta(c) {
    return Promise.all([
      api(`${c.teamBase}/_apis/work/teamsettings/iterations`),
      api(`${c.teamBase}/_apis/work/teamsettings`),
      api(`${c.teamBase}/_apis/work/teamsettings/teamfieldvalues`),
      api(`${c.projBase}/_apis/work/processconfiguration`),
      api(`${c.projBase}/_apis/wit/workitemtypes`),
    ]).then(([its, ts, tf, pc, wits]) => {
      const names = list => (list || []).map(t => t.name);
      const req = names(pc.requirementBacklog && pc.requirementBacklog.workItemTypes);
      const task = names(pc.taskBacklog && pc.taskBacklog.workItemTypes);
      const bug = names(pc.bugWorkItems && pc.bugWorkItems.workItemTypes);
      const bugMode = ts.bugsBehavior; // asRequirements | asTasks | off
      const parentTypes = [...req, ...(bugMode === 'asRequirements' ? bug : [])];
      const childTypes = [...task, ...(bugMode === 'asTasks' ? bug : [])];
      const countTypes = [...req, ...(bugMode !== 'off' ? bug : []), ...task];
      const effortTypes = new Set(parentTypes);
      const witMap = new Map(wits.value.map(w => [w.name, w]));
      const removed = new Set();
      wits.value.forEach(w => (w.states || []).forEach(s => {
        if (s.category === 'Removed') removed.add(w.name + '|' + s.name);
      }));
      return {
        iterations: its.value.filter(i => i.attributes && i.attributes.startDate && i.attributes.finishDate),
        workingDays: new Set((ts.workingDays || []).map(d => d.toLowerCase())),
        teamField: tf.field.referenceName,
        teamFieldValues: tf.values,
        effortField: pc.typeFields && pc.typeFields.Effort && pc.typeFields.Effort.referenceName,
        countTypes: [...new Set(countTypes)],
        parentTypes,
        childTypes,
        effortTypes,
        witMap,
        removed,
      };
    });
  }

  const q = s => `'${String(s).replace(/'/g, "''")}'`;

  async function loadStats(c, meta, extras) {
    const stats = new Map(extras.map(it => [it.id, { effort: 0, counts: {}, workingDays: null }]));
    if (!extras.length) return stats;
    const byPath = new Map(extras.map(it => [it.path.toLowerCase(), it.id]));

    const teamClause = prefix => meta.teamFieldValues
      .map(v => `[${prefix}${meta.teamField}] ${v.includeChildren ? 'UNDER' : '='} ${q(v.value)}`)
      .join(' OR ');
    const paths = extras.map(it => q(it.path)).join(',');
    const tc = teamClause('');
    const wiql = `SELECT [System.Id] FROM WorkItems
      WHERE [System.TeamProject] = @project
      AND [System.IterationPath] IN (${paths})
      AND [System.WorkItemType] IN (${meta.countTypes.map(q).join(',')})
      ${tc ? `AND (${tc})` : ''}`;
    // Like the native pane, count parents (e.g. Requirements) of tasks in the sprint even
    // when the parent itself lives in another iteration.
    const ltc = teamClause('Target].[');
    const linkWiql = meta.parentTypes.length && meta.childTypes.length && `SELECT [System.Id] FROM WorkItemLinks
      WHERE [Source].[System.WorkItemType] IN (${meta.parentTypes.map(q).join(',')})
      AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
      AND [Target].[System.IterationPath] IN (${paths})
      AND [Target].[System.WorkItemType] IN (${meta.childTypes.map(q).join(',')})
      ${ltc ? `AND (${ltc})` : ''}
      MODE (MustContain)`;

    const daysOffP = Promise.all(extras.map(it =>
      api(`${c.teamBase}/_apis/work/teamsettings/iterations/${it.id}/teamdaysoff`)
        .then(r => [it.id, r.daysOff || []])
        .catch(() => [it.id, []])
    ));

    const [res, linkRes] = await Promise.all([
      api(`${c.teamBase}/_apis/wit/wiql`, { query: wiql }),
      linkWiql ? api(`${c.teamBase}/_apis/wit/wiql`, { query: linkWiql }) : { workItemRelations: [] },
    ]);
    const links = (linkRes.workItemRelations || []).filter(r => r.source && r.target);
    const ids = [...new Set([
      ...(res.workItems || []).map(w => w.id),
      ...links.flatMap(l => [l.source.id, l.target.id]),
    ])];
    const fields = ['System.IterationPath', 'System.WorkItemType', 'System.State'];
    if (meta.effortField) fields.push(meta.effortField);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
    const batches = await Promise.all(chunks.map(chunk =>
      api(`${c.projBase}/_apis/wit/workitemsbatch`, { ids: chunk, fields })));

    const items = new Map();
    for (const b of batches) for (const wi of b.value) {
      const f = wi.fields;
      items.set(wi.id, {
        type: f['System.WorkItemType'],
        path: String(f['System.IterationPath']).toLowerCase(),
        removed: meta.removed.has(f['System.WorkItemType'] + '|' + f['System.State']),
        effort: Number(meta.effortField && f[meta.effortField]) || 0,
      });
    }
    const add = (s, type) => { s.counts[type] = (s.counts[type] || 0) + 1; };

    for (const w of res.workItems || []) {
      const it = items.get(w.id);
      const s = it && !it.removed && stats.get(byPath.get(it.path));
      if (!s) continue;
      add(s, it.type);
      if (meta.effortTypes.has(it.type)) s.effort += it.effort;
    }

    const seen = new Set();
    for (const l of links) {
      const child = items.get(l.target.id);
      const parent = items.get(l.source.id);
      if (!child || !parent || child.removed || parent.removed || parent.path === child.path) continue;
      const s = stats.get(byPath.get(child.path));
      const k = l.source.id + '|' + child.path;
      if (!s || seen.has(k)) continue;
      seen.add(k);
      add(s, parent.type);
    }

    const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (const [id, off] of await daysOffP) {
      const it = extras.find(x => x.id === id);
      const ranges = off.map(o => [Date.parse(o.start), Date.parse(o.end)]);
      let n = 0;
      const end = Date.parse(it.attributes.finishDate);
      for (let t = Date.parse(it.attributes.startDate); t <= end; t += 864e5) {
        if (!meta.workingDays.has(DAYS[new Date(t).getUTCDay()])) continue;
        if (ranges.some(([a, b]) => t >= a && t <= b)) continue;
        n++;
      }
      stats.get(id).workingDays = n;
    }
    return stats;
  }

  // ---------- DOM helpers ----------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function iterationHref(c, it) {
    return c.sprintsBase + '/' + it.path.split('\\').map(encodeURIComponent).join('/');
  }

  function nativeCards(list) {
    return [...list.querySelectorAll('.planning-sprint-card')].filter(n => !n.closest('#' + ROOT_ID));
  }

  // Index (in team iteration order) of the last sprint the native pane shows.
  function findExtras(list, meta) {
    const shown = new Set(nativeCards(list)
      .map(card => card.querySelector('a.bolt-link'))
      .filter(Boolean)
      .map(a => decodeURIComponent(new URL(a.href, location.href).pathname).toLowerCase()));
    const isShown = it => [...shown].some(p => p.endsWith('/' + it.path.replace(/\\/g, '/').toLowerCase()));
    let last = -1;
    meta.iterations.forEach((it, i) => { if (isShown(it)) last = i; });
    if (last >= 0) return meta.iterations.slice(last + 1);
    return meta.iterations.filter(it => it.attributes.timeFrame !== 'past' && !isShown(it));
  }

  // Match the date format the native cards use (falls back to dd-MM-yyyy).
  function detectFormat(list, meta) {
    const p = n => String(n).padStart(2, '0');
    const parts = d => ({ d: d.getUTCDate(), m: d.getUTCMonth() + 1, y: d.getUTCFullYear() });
    const fmts = [
      x => `${p(x.d)}-${p(x.m)}-${x.y}`, x => `${p(x.d)}/${p(x.m)}/${x.y}`, x => `${p(x.d)}.${p(x.m)}.${x.y}`,
      x => `${p(x.m)}/${p(x.d)}/${x.y}`, x => `${x.m}/${x.d}/${x.y}`, x => `${x.d}/${x.m}/${x.y}`,
      x => `${x.y}-${p(x.m)}-${p(x.d)}`, x => `${x.y}/${p(x.m)}/${p(x.d)}`, x => `${x.d}.${x.m}.${x.y}`,
    ];
    for (const card of nativeCards(list)) {
      const name = card.querySelector('a.bolt-link')?.textContent.trim();
      const text = card.querySelector('.flex-self-end')?.textContent.trim();
      const it = meta.iterations.find(i => i.name === name);
      if (!it || !text) continue;
      const s = parts(new Date(it.attributes.startDate));
      const f = fmts.find(fn => text.startsWith(fn(s)));
      if (f) return d => f(parts(d));
    }
    return d => fmts[0](parts(d));
  }

  function typeIcon(list, meta, type) {
    const native = list.querySelector(`.planning-sprint-card [role="img"][aria-label="${CSS.escape(type)}"]`);
    if (native) return native.cloneNode(true);
    const wit = meta.witMap.get(type);
    const span = el('span');
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', type);
    span.title = type;
    if (wit && wit.icon && wit.icon.url) {
      const img = el('img', 'margin-right-4');
      img.src = wit.icon.url;
      img.alt = '';
      img.style.cssText = 'width:14px;height:14px;vertical-align:text-bottom';
      span.append(img);
    } else {
      span.append(el('span', 'margin-right-4', type[0]));
    }
    return span;
  }

  function ensureStyles() {
    if (document.getElementById(ROOT_ID + '-style')) return;
    const style = el('style');
    style.id = ROOT_ID + '-style';
    style.textContent = `
      #${ROOT_ID} .ams-refresh { padding: 0 4px; margin-left: 4px; height: 20px; min-width: 0; align-self: center; }
      #${ROOT_ID} .ams-refresh .fabric-icon { font-size: 12px; }
      #${ROOT_ID} .ams-refresh.ams-busy { pointer-events: none; opacity: .6; }
      #${ROOT_ID} .ams-refresh.ams-busy .fabric-icon { animation: ams-spin 1s linear infinite; }
      #${ROOT_ID} .ams-refresh.ams-failed .fabric-icon { color: var(--status-error-foreground, #cd4a45); }
      @keyframes ams-spin { to { transform: rotate(360deg); } }`;
    document.head.append(style);
  }

  function buildRefreshButton(c, list, meta, it, tr) {
    const busy = state.refreshing.has(it.id);
    const failed = state.refreshErrors.get(it.id);
    const btn = el('button', 'ams-refresh bolt-button bolt-icon-button enabled subtle icon-only bolt-focus-treatment'
      + (busy ? ' ams-busy' : '') + (failed ? ' ams-failed' : ''));
    btn.type = 'button';
    btn.title = failed ? `Refresh failed: ${failed} – click to retry` : `Refresh ${it.name}`;
    btn.setAttribute('aria-label', btn.title);
    const icon = el('span', 'fluent-icons-enabled');
    icon.append(el('span', 'flex-noshrink fabric-icon ms-Icon--Refresh'));
    btn.append(icon);
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      refreshOne(c, list, meta, it, tr);
    });
    return btn;
  }

  async function refreshOne(c, list, meta, it, tr) {
    if (state.refreshing.has(it.id)) return;
    const key = state.key;
    state.refreshing.add(it.id);
    state.refreshErrors.delete(it.id);
    let row = swapCard(c, list, meta, it, tr);
    try {
      const fresh = await loadStats(c, meta, [it]);
      if (!state.stats) state.stats = new Map();
      state.stats.set(it.id, fresh.get(it.id));
    } catch (e) {
      state.refreshErrors.set(it.id, e.message);
    }
    state.refreshing.delete(it.id);
    if (state.key !== key) return;
    // The list may have been re-rendered meanwhile; find the current row for this sprint.
    row = (row.isConnected ? row : document.querySelector(`#${ROOT_ID} tr[data-iteration-id="${it.id}"]`));
    if (row) swapCard(c, list, meta, it, row);
  }

  function swapCard(c, list, meta, it, tr) {
    const next = buildCard(c, list, meta, it, state.stats && state.stats.get(it.id));
    tr.replaceWith(next);
    return next;
  }

  function buildCard(c, list, meta, it, s) {
    const fmtNum = n => String(Math.round(n * 100) / 100);
    const tr = el('tr', 'bolt-list-row');
    tr.setAttribute('role', 'listitem');
    tr.dataset.iterationId = it.id;
    const td = el('td', 'bolt-list-cell');
    const content = el('div', 'bolt-list-cell-content flex-row');
    const card = el('div', 'planning-sprint-card margin-top-8 flex-grow bolt-card flex-column depth-8 bolt-card-white');
    const cc = el('div', 'bolt-card-content flex-row flex-grow bolt-default-horizontal-spacing');
    const inner = el('div', 'flex-column flex-grow planning-inner');

    const r1 = el('div', 'flex-row');
    const nameWrap = el('div', 'flex-grow');
    const a = el('a', 'bolt-link', it.name);
    a.href = iterationHref(c, it);
    nameWrap.append(a);
    const dates = `${state.fmt(new Date(it.attributes.startDate))} - ${state.fmt(new Date(it.attributes.finishDate))}`;
    r1.append(nameWrap, el('span', 'flex-self-end', dates), buildRefreshButton(c, list, meta, it, tr));

    const r2 = el('div', 'flex-row secondary-text');
    r2.append(
      el('span', 'flex-grow secondary-text', s ? `Planned Effort: ${fmtNum(s.effort)}` : 'Planned Effort: …'),
      el('span', 'secondary-text flex-self-end', s && s.workingDays != null ? `${s.workingDays} working days` : '')
    );
    inner.append(r1, r2);

    if (s) {
      const types = meta.countTypes.filter(t => s.counts[t]);
      if (types.length) {
        const r3 = el('div', 'flex-row padding-top-8');
        types.forEach((t, i) => {
          const d = el('div', i ? 'margin-left-16' : '');
          d.append(typeIcon(list, meta, t), el('span', 'font-weight-semibold', String(s.counts[t])));
          r3.append(d);
        });
        inner.append(r3);
      }
    }

    cc.append(inner);
    card.append(cc);
    content.append(card);
    td.append(content);
    tr.append(td);
    return tr;
  }

  // ---------- render ----------

  async function render(c, list, root) {
    let meta;
    try {
      meta = await state.meta;
    } catch (e) {
      root.replaceChildren(el('div', 'secondary-text margin-top-8', 'More sprints unavailable: ' + e.message));
      return;
    }
    if (!root.isConnected || state.key !== c.key) return;

    const extras = findExtras(list, meta);
    if (!state.fmt) state.fmt = detectFormat(list, meta);
    root.replaceChildren();
    if (!extras.length) return;

    if (state.expanded) {
      ensureStyles();
      const table = el('table', 'flex-card full-width bolt-list body-m relative');
      table.setAttribute('role', 'list');
      const tbody = el('tbody', 'relative');
      tbody.setAttribute('role', 'presentation');
      extras.forEach(it => tbody.append(buildCard(c, list, meta, it, state.stats && state.stats.get(it.id))));
      table.append(tbody);
      root.append(table);
      if (state.error) root.append(el('div', 'secondary-text margin-top-8', 'Could not load sprint details: ' + state.error));
    }

    const btn = el('button', 'bolt-button enabled subtle bolt-focus-treatment');
    btn.type = 'button';
    btn.style.cssText = 'width:100%;justify-content:center;margin:8px 0';
    const label = state.expanded
      ? (state.loading ? 'Loading sprint details…' : 'Show less')
      : `Show more (${extras.length} sprint${extras.length === 1 ? '' : 's'})`;
    btn.append(el('span', 'bolt-button-text body-m', label));
    btn.setAttribute('aria-expanded', String(state.expanded));
    btn.addEventListener('click', () => toggle(c, list, root));
    root.append(btn);
  }

  async function refreshStats(c, list, root) {
    const meta = await state.meta;
    const extras = findExtras(list, meta);
    state.loading = true;
    state.error = null;
    render(c, list, root);
    try {
      state.stats = await loadStats(c, meta, extras);
    } catch (e) {
      state.error = e.message;
    }
    state.loading = false;
    if (state.key === c.key) render(c, list, root);
  }

  function toggle(c, list, root) {
    state.expanded = !state.expanded;
    if (state.expanded) refreshStats(c, list, root);  // always fetch fresh numbers on open
    else render(c, list, root);
  }

  // ---------- lifecycle ----------

  function nativeSignature(list) {
    return nativeCards(list).map(n => n.textContent).join('|');
  }

  function ensure() {
    const c = getContext();
    const existing = document.getElementById(ROOT_ID);
    if (!c) { existing && existing.remove(); return; }

    if (state.key !== c.key) {
      Object.assign(state, {
        key: c.key, expanded: false, stats: null, error: null, nativeSig: '', fmt: null,
        refreshing: new Set(), refreshErrors: new Map(),
      });
      state.meta = loadMeta(c);
      existing && existing.remove();
    }

    const list = document.querySelector('.planning-list');
    if (!list) return;
    const table = [...list.children].find(n => n.matches('table.bolt-list'));
    if (!table) return;

    let root = document.getElementById(ROOT_ID);
    if (!root || root.parentElement !== list) {
      root && root.remove();
      root = el('div');
      root.id = ROOT_ID;
      list.append(root);
      state.nativeSig = nativeSignature(list);
      render(c, list, root);
      return;
    }

    // Native cards changed (sprint switched, items dragged onto a sprint, …) → re-sync.
    const sig = nativeSignature(list);
    if (sig !== state.nativeSig) {
      state.nativeSig = sig;
      if (state.expanded && !state.loading) refreshStats(c, list, root);
      else render(c, list, root);
    }
  }

  let timer = 0;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(ensure, 250);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  ensure();
})();
