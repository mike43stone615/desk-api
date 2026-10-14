// Administration (Desk administrators only): flip between the Desk, Business Name Registry and Market Validation APIs and edit
// their data. The "Who has access" pop-up lists the owners and administrators; owners invite, remove and promote administrators.
// Data comes from /admin/tables (src/routes/admin.ts), who has access from /admin/access (src/routes/adminAccess.ts).
// The tab is only shown to administrators and every request is checked again on the server; hiding is a convenience, not the lock.
import { registerRoute, api, esc, spinnerBtn, toast, icon, friendlyError, ADMIN_FILTER_DEBOUNCE_MS, reportHandledException, navigate, statusMsg, submitOnEnter, currentEpoch } from '../app.js';
import { tabsHtml } from '../tabs.js';

const ROWS_PAGE_SIZE = 100;

// Table and column names ("oauth_clients", "api_key_id") as people read them: Title Case, but acronyms stay upper case
// ("API Key ID"), a few names have their own spelling ("OAuth"), and small words in the middle stay lower case.
const ACRONYMS = new Set(['api', 'id', 'ids', 'url', 'urls', 'uri', 'uris', 'ip', 'ips', 'otp', 'mfa', 'sso', 'sms', 'sql', 'json', 'csv', 'pdf', 'html', 'ein', 'ssn', 'llc', 'sba', 'oews', 'naics', 'soc', 'fips', 'bls', 'bea', 'jolts', 'ppi', 'bfs', 'laus', 'ui', 'tls', 'ttl', 'uuid']);
const SPELLINGS = { oauth: 'OAuth', graphql: 'GraphQL', webhooks: 'Webhooks' };
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'per', 'the', 'to']);
function titleize(value) {
  const spaced = value.replace(/\./g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return spaced.split('_').filter(Boolean).map((p, i) => {
    const w = p.toLowerCase();
    if (SPELLINGS[w]) return SPELLINGS[w];
    if (ACRONYMS.has(w)) return w.toUpperCase();
    if (i > 0 && SMALL_WORDS.has(w)) return w;
    return w[0].toUpperCase() + w.slice(1);
  }).join(' ');
}
function cellKey(table, id, column) { return `${table}:${id}:${column}`; }
function displayValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
function isDefaultHiddenColumn(column) {
  const n = column.toLowerCase();
  return ['metadata', 'payload', 'raw', 'json', 'preferences', 'embedding', 'secret'].some((k) => n.includes(k));
}
function columnWidth(column) {
  const n = column.toLowerCase();
  if (n === 'id' || n.endsWith('_id') || n.endsWith('id')) return 148;
  if (n.startsWith('is_') || n.startsWith('has_') || n.startsWith('can_') || n === 'active' || n === 'enabled') return 112;
  if (['count', 'total', 'amount', 'price'].some((k) => n.includes(k))) return 128;
  if (['json', 'metadata', 'preferences', 'description', 'notes'].some((k) => n.includes(k))) return 260;
  if (['email', 'phone', 'address', 'url'].some((k) => n.includes(k))) return 220;
  if (['created', 'updated', 'date', 'time'].some((k) => n.includes(k))) return 176;
  return 180;
}
function normalizeEditedValue(text, oldValue) {
  if (text.toLowerCase() === 'null') return { value: null };
  if (typeof oldValue === 'number') {
    const n = Number(text);
    return Number.isFinite(n) && text.trim() !== '' ? { value: n } : { error: 'Enter a number.' };
  }
  if (typeof oldValue === 'boolean') {
    const lower = text.toLowerCase();
    if (lower === 'true') return { value: true };
    if (lower === 'false') return { value: false };
    return { error: 'Enter true or false.' };
  }
  if (oldValue !== null && typeof oldValue === 'object') {
    try { return { value: JSON.parse(text) }; } catch { return { error: 'Enter valid JSON.' }; }
  }
  return { value: text };
}

registerRoute('/developer/admin', async (app) => {
  const myEpoch = currentEpoch();
  const isCurrent = () => currentEpoch() === myEpoch;
  const s = {
    me: null, accessOpen: false, access: null, accessError: null, isAccessLoading: false,
    addEmail: '', addError: null, isAdding: false, confirmAccess: null, isAccessBusy: false,
    gridScrollLeft: 0,
    tables: [], rows: null, selectedTable: null, selectedSource: 'desk',
    errorMessage: null, isLoading: true, isSaving: false,
    undoStack: [], redoStack: [], savingCellKeys: new Set(),
    filters: {}, sort: null, hiddenColumnsByTable: {},
    hasMoreRows: false, isLoadingMoreRows: false, isRefreshingRows: false,
    selectedRowId: null, columnMenuOpen: false, editingCell: null, confirmDeleteRow: null,
    activeFilter: null, // the column filter being typed in: it keeps the keyboard while the rows update under it
  };
  let filterDebounce = null;
  let rendering = false; // a redraw replaces the filter boxes; their blur then is not the person leaving them

  async function loadTables() {
    s.isLoading = true; s.errorMessage = null; render();
    try {
      const data = await api('/admin/tables');
      const nextTables = data.tables || [];
      s.sourceErrors = data.sourceErrors || null;
      const availableSources = new Set(nextTables.map((t) => t.source));
      const nextSource = availableSources.has(s.selectedSource) ? s.selectedSource : (nextTables[0]?.source || s.selectedSource);
      const sourceTables = nextTables.filter((t) => t.source === nextSource);
      const tableName = s.selectedTable && sourceTables.some((t) => t.name === s.selectedTable) ? s.selectedTable : (sourceTables[0]?.name || null);
      let nextRows = null;
      if (tableName) nextRows = await fetchRows(tableName, { limit: ROWS_PAGE_SIZE });
      s.tables = nextTables; s.selectedSource = nextSource; s.selectedTable = tableName; s.rows = nextRows;
      s.filters = {}; s.sort = null;
      initializeHiddenColumns(nextRows);
      s.hasMoreRows = hasMore(nextRows);
    } catch (err) {
      reportHandledException(err, 'loadTables');
      s.errorMessage = friendlyError(err, 'We could not load the data tables.');
    } finally {
      s.isLoading = false; render();
    }
  }

  async function fetchRows(table, { limit = ROWS_PAGE_SIZE, offset = 0, filters = {}, sort } = {}) {
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (Object.keys(filters).length) q.set('filters', JSON.stringify(filters));
    if (sort) { q.set('sortColumn', sort.column); q.set('sortDirection', sort.ascending ? 'asc' : 'desc'); }
    const data = await api(`/admin/tables/${table}/rows?${q.toString()}`);
    return {
      table: data.table || '', source: data.source || 'desk', rawName: data.rawName || data.table || '',
      primaryKey: data.primaryKey || 'id', columns: data.columns || [], editableColumns: data.editableColumns || [],
      secretColumns: data.secretColumns || [], columnOptions: data.columnOptions || {},
      rows: data.rows || [], totalRows: Number(data.totalRows) || 0, deletable: data.deletable === true,
      // Very large tables (millions of rows) give an estimated total, and say themselves whether more rows follow.
      totalIsEstimate: data.totalIsEstimate === true, serverHasMore: typeof data.hasMore === 'boolean' ? data.hasMore : null,
    };
  }
  function hasMore(rows) {
    if (!rows) return false;
    return rows.serverHasMore !== null && rows.serverHasMore !== undefined ? rows.serverHasMore : rows.rows.length < rows.totalRows;
  }
  /** "1,234 rows"; "about 14,876,297 rows" for a large table's estimate; "10,000+ rows" for a filter's capped count. */
  function totalText(t) {
    const n = Number(t.totalRows).toLocaleString('en-US');
    if (!t.totalIsEstimate) return `${n} rows`;
    return Object.keys(s.filters).length ? `${n}+ rows` : `about ${n} rows`;
  }
  function initializeHiddenColumns(rows) {
    if (!rows) return;
    if (!(rows.table in s.hiddenColumnsByTable)) {
      s.hiddenColumnsByTable[rows.table] = new Set(rows.columns.filter(isDefaultHiddenColumn));
    }
  }

  async function selectSource(source) {
    const table = s.tables.find((t) => t.source === source);
    if (!table) return;
    s.selectedSource = source;
    await selectTable(table.name);
  }
  async function selectTable(table) {
    s.selectedTable = table; s.isLoading = true; s.errorMessage = null; s.gridScrollLeft = 0;
    // Undo and redo keep the person's own edits across tables: each change remembers its table and row.
    s.filters = {}; s.sort = null; s.selectedRowId = null; s.editingCell = null; s.activeFilter = null;
    render();
    try {
      const nextRows = await fetchRows(table, { limit: ROWS_PAGE_SIZE });
      s.rows = nextRows; initializeHiddenColumns(nextRows); s.hasMoreRows = hasMore(nextRows);
    } catch (err) {
      reportHandledException(err, 'selectTable');
      s.errorMessage = friendlyError(err, 'We could not load that table.');
    } finally {
      s.isLoading = false; render();
    }
  }
  async function refreshRows({ announce = false } = {}) {
    if (!s.selectedTable) return;
    s.isRefreshingRows = true; render();
    try {
      const nextRows = await fetchRows(s.selectedTable, { limit: ROWS_PAGE_SIZE, filters: s.filters, sort: s.sort });
      s.rows = nextRows; s.hasMoreRows = hasMore(nextRows); s.errorMessage = null;
      if (announce) toast(`Up to date · ${totalText(nextRows)}`);
    } catch (err) {
      reportHandledException(err, 'refreshRows');
      s.errorMessage = friendlyError(err, 'We could not refresh that table.');
    } finally {
      s.isRefreshingRows = false; render();
    }
  }
  async function loadMoreRows() {
    if (!s.selectedTable || !s.rows || s.isLoadingMoreRows || !s.hasMoreRows) return;
    s.isLoadingMoreRows = true; render();
    try {
      const next = await fetchRows(s.selectedTable, { limit: ROWS_PAGE_SIZE, offset: s.rows.rows.length, filters: s.filters, sort: s.sort });
      s.rows = { ...s.rows, rows: [...s.rows.rows, ...next.rows], totalRows: next.totalRows, totalIsEstimate: next.totalIsEstimate, serverHasMore: next.serverHasMore };
      s.hasMoreRows = hasMore(s.rows);
    } catch (err) {
      reportHandledException(err, 'loadMoreRows');
      s.errorMessage = friendlyError(err, 'We could not load more rows.');
    } finally {
      s.isLoadingMoreRows = false; render();
    }
  }

  function handleFilterChanged(column, value) {
    const trimmed = value.trim();
    if (trimmed) s.filters[column] = trimmed; else delete s.filters[column];
    if (filterDebounce) clearTimeout(filterDebounce);
    filterDebounce = setTimeout(refreshRows, ADMIN_FILTER_DEBOUNCE_MS);
  }
  /** Enter: the filter is done. The rows update at once and the box lets go of the keyboard. */
  function finishFilter(column, value) {
    if (filterDebounce) clearTimeout(filterDebounce);
    const trimmed = value.trim();
    if (trimmed) s.filters[column] = trimmed; else delete s.filters[column];
    s.activeFilter = null;
    refreshRows();
  }
  function clearFilters() { if (!Object.keys(s.filters).length) return; s.filters = {}; refreshRows(); }
  function removeFilter(column) { if (!(column in s.filters)) return; delete s.filters[column]; refreshRows(); }
  function handleSortChanged(column) {
    s.sort = s.sort && s.sort.column === column ? { column, ascending: !s.sort.ascending } : { column, ascending: true };
    refreshRows();
  }

  async function applyChange(change, useNewValue) {
    const value = useNewValue ? change.newValue : change.oldValue;
    const key = cellKey(change.table, change.id, change.column);
    s.savingCellKeys.add(key); s.isSaving = true; s.errorMessage = null; render();
    try {
      const saved = await api(`/admin/tables/${change.table}/rows/${change.id}`, { method: 'PATCH', body: { values: { [change.column]: value } } });
      if (s.rows && s.rows.table === change.table) {
        // The saved row as the server stored it (the value as typed for the column, and a new row key when a key column changed).
        const next = saved && saved.row ? saved.row : null;
        s.rows = { ...s.rows, rows: s.rows.rows.map((r) => (String(r[s.rows.primaryKey]) === change.id ? (next || { ...r, [change.column]: value }) : r)) };
        // Undo and redo hold this same change: they must find the row under its new key.
        if (next && next[s.rows.primaryKey] != null) {
          const newId = String(next[s.rows.primaryKey]);
          if (s.selectedRowId === change.id) s.selectedRowId = newId; // the open expanded row follows its new key
          change.id = newId;
        }
      }
    } catch (err) {
      reportHandledException(err, 'saveCell');
      s.errorMessage = friendlyError(err, 'We could not save that change.');
    } finally {
      s.savingCellKeys.delete(key); s.isSaving = s.savingCellKeys.size > 0; render();
    }
  }
  async function editCell(row, column, rawText) {
    if (!s.rows || !s.rows.editableColumns.includes(column)) return;
    const id = String(row[s.rows.primaryKey]);
    if (s.savingCellKeys.has(cellKey(s.rows.table, id, column))) return;
    const oldValue = row[column];
    const { value: normalized, error } = normalizeEditedValue(rawText, oldValue);
    // On an invalid value, leave s.editingCell alone (still the caller's
    // responsibility, not cleared here) so the cell keeps rendering as an
    // editable textarea instead of silently reverting to read-only with the
    // edit discarded — the caller no longer clears it before calling us.
    if (error) { toast(error, true); return; }
    s.editingCell = null;
    if (String(oldValue ?? '') === String(normalized ?? '')) { render(); return; }
    const change = { table: s.rows.table, id, column, oldValue, newValue: normalized };
    await applyChange(change, true);
    if (s.errorMessage) return;
    s.undoStack.push(change); s.redoStack = [];
    render(); // applyChange() already redrew, before the history above changed
  }
  async function toggleBool(row, column) {
    if (!s.rows || !s.rows.editableColumns.includes(column)) return;
    const id = String(row[s.rows.primaryKey]);
    const change = { table: s.rows.table, id, column, oldValue: row[column], newValue: !row[column] };
    await applyChange(change, true);
    if (s.errorMessage) return;
    s.undoStack.push(change); s.redoStack = [];
    render();
  }
  const changeLabel = (c) => `${titleize(c.table)} · ${titleize(c.column)}`;
  async function undo() {
    if (!s.undoStack.length || s.isSaving) return;
    const change = s.undoStack.pop();
    await applyChange(change, false);
    if (s.errorMessage) { s.undoStack.push(change); render(); return; } // still there to try again
    s.redoStack.push(change); render();
    toast(`Undone: ${changeLabel(change)}`);
  }
  async function redo() {
    if (!s.redoStack.length || s.isSaving) return;
    const change = s.redoStack.pop();
    await applyChange(change, true);
    if (s.errorMessage) { s.redoStack.push(change); render(); return; }
    s.undoStack.push(change); render();
    toast(`Redone: ${changeLabel(change)}`);
  }
  function deleteRow(row) {
    if (!s.rows || !s.rows.deletable) return;
    s.confirmDeleteRow = row;
    render();
  }
  async function confirmDeleteRow() {
    const row = s.confirmDeleteRow;
    if (!s.rows || !row) return;
    const id = String(row[s.rows.primaryKey]);
    const table = s.rows.table;
    s.confirmDeleteRow = null; render();
    try {
      await api(`/admin/tables/${table}/rows/${encodeURIComponent(id)}`, { method: 'DELETE' });
      // Only this row's edits leave the history: they cannot be undone on a row that no longer exists.
      const other = (c) => !(c.table === table && c.id === id);
      s.undoStack = s.undoStack.filter(other); s.redoStack = s.redoStack.filter(other);
      if (s.selectedRowId === id) s.selectedRowId = null;
      toast('Row deleted.');
      await refreshRows();
    } catch (err) {
      reportHandledException(err, 'deleteRow');
      s.errorMessage = friendlyError(err, 'We could not delete that row.');
      render();
    }
  }

  async function loadAccess() {
    s.isAccessLoading = true; s.accessError = null; render();
    try { s.access = await api('/admin/access'); } catch (err) {
      reportHandledException(err, 'loadAdminAccess');
      s.accessError = friendlyError(err, 'We could not load the list.');
    } finally { s.isAccessLoading = false; if (isCurrent()) render(); }
  }
  async function addAdminPerson(e) {
    e.preventDefault();
    if (s.isAdding) return;
    if (!s.addEmail.trim()) { s.addError = 'Enter the email address of a Desk account.'; render(); return; }
    s.isAdding = true; s.addError = null; render();
    try {
      await api('/admin/access', { method: 'POST', body: { email: s.addEmail.trim() } });
      s.addEmail = '';
      toast('Added. They can see the Administration tab the next time they open the page.');
      s.access = await api('/admin/access');
    } catch (err) {
      reportHandledException(err, 'addAdmin');
      s.addError = friendlyError(err, 'We could not add that person.');
    } finally { s.isAdding = false; if (isCurrent()) render(); }
  }
  // Remove and promote both ask first (in a second pop-up over the list), then reload the list.
  async function confirmAccessChange() {
    const target = s.confirmAccess;
    if (!target || s.isAccessBusy) return;
    s.isAccessBusy = true; render();
    try {
      if (target.kind === 'promote') {
        await api(`/admin/access/${encodeURIComponent(target.userId)}/promote`, { method: 'POST' });
        toast(`${target.name} is now an owner.`);
      } else {
        await api(`/admin/access/${encodeURIComponent(target.userId)}`, { method: 'DELETE' });
        toast('Access removed.');
      }
      s.access = await api('/admin/access');
    } catch (err) {
      reportHandledException(err, target.kind === 'promote' ? 'promoteAdmin' : 'removeAdmin');
      toast(friendlyError(err, target.kind === 'promote' ? 'We could not make that person an owner.' : 'We could not remove that person.'), true);
    } finally { s.confirmAccess = null; s.isAccessBusy = false; if (isCurrent()) render(); }
  }
  function personName(p) { return `${p.firstName || ''} ${p.lastName || ''}`.trim(); }
  function personRowHtml(p, actions = '') {
    const name = personName(p);
    return `
      <div class="access-person">
        <div class="access-person-text">
          <div class="access-person-name">${esc(name || p.email)}</div>
          ${name ? `<div class="access-person-email">${esc(p.email)}</div>` : ''}
        </div>
        ${actions}
      </div>`;
  }
  function accessModalHtml() {
    const isOwner = s.me && s.me.isOwner;
    let body;
    if (s.isAccessLoading && !s.access) body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`;
    else if (s.accessError) body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">The list could not load</div><div class="hint">${esc(s.accessError)}</div><button type="button" class="btn" id="retry-access-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    else {
      const a = s.access || { owners: [], admins: [] };
      body = `
        <h3 class="access-group-title">Owners</h3>
        <div class="access-list">${a.owners.map((o) => personRowHtml(o)).join('') || '<p class="modal-text">None set.</p>'}</div>
        <h3 class="access-group-title">Administrators</h3>
        <div class="access-list">${a.admins.length ? a.admins.map((p) => personRowHtml(p, isOwner ? `
          <div class="access-person-actions">
            <button type="button" class="btn btn-sm" data-promote-admin="${esc(p.userId)}" data-name="${esc(personName(p) || p.email)}">Make owner</button>
            <button type="button" class="btn btn-sm" data-remove-admin="${esc(p.userId)}" data-name="${esc(personName(p) || p.email)}">Remove</button>
          </div>` : '')).join('') : '<p class="modal-text">No administrators yet.</p>'}</div>
        ${isOwner ? `
          <form id="add-admin-form" class="access-invite" novalidate>
            <div class="field-float has-icon"><span class="field-icon">${icon('person_add')}</span><label>Invite by email</label><input name="email" type="email" placeholder=" " value="${esc(s.addEmail)}" autocomplete="off" /></div>
            <button type="submit" class="btn btn-primary" ${s.isAdding ? 'disabled' : ''}>${s.isAdding ? spinnerBtn(true, '') : 'Invite'}</button>
          </form>
          ${s.addError ? statusMsg('error', s.addError, true) : ''}
          <p class="modal-text access-invite-hint">They need a Desk account with a confirmed email address.</p>` : ''}`;
    }
    return `
      <div class="modal-backdrop" id="access-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="access-title">
          <div class="access-modal-head"><h2 id="access-title">Who has access</h2><button type="button" class="admin-icon-btn" id="close-access-btn" title="Close" aria-label="Close">${icon('close')}</button></div>
          ${body}
        </div>
      </div>`;
  }
  function confirmAccessHtml() {
    const c = s.confirmAccess;
    const promote = c.kind === 'promote';
    return `
      <div class="modal-backdrop" id="confirm-access-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-access-title">
          <h2 id="confirm-access-title">${promote ? 'Make owner' : 'Remove access'}</h2>
          <p class="modal-text">${promote
            ? `Make ${esc(c.name)} an owner? Owners can invite, remove and promote administrators. Owners cannot be removed or demoted here afterwards.`
            : `Take away administrator access from ${esc(c.name)}? It stops at once.`}</p>
          <div class="modal-actions">
            <button type="button" class="btn" id="cancel-access-btn" ${s.isAccessBusy ? 'disabled' : ''}>Cancel</button>
            <button type="button" class="btn ${promote ? 'btn-primary' : 'btn-danger'}" id="confirm-access-btn" ${s.isAccessBusy ? 'disabled' : ''}>${s.isAccessBusy ? spinnerBtn(true, '') : promote ? 'Make owner' : 'Remove'}</button>
          </div>
        </div>
      </div>`;
  }

  function render() {
    if (!isCurrent()) return; // a page the person has already left must not draw over the new one
    const sources = [...new Set(s.tables.map((t) => t.source))];
    const sourceLabels = { desk: 'Desk API', registry: 'Business Name Registry API', market: 'Market Validation API', compliance: 'Compliance (retired)' };
    const sourceTables = s.tables.filter((t) => t.source === s.selectedSource);

    rendering = true;
    app.innerHTML = `
      <div class="page">
        <div class="page-head-row">
          <div class="head-text"><h1>API Library</h1><p>View and edit the data behind each API.</p></div>
        </div>
        ${tabsHtml('/developer/admin')}
        <div class="admin-source-row">
          <div class="source-tabs" aria-label="API">${sources.map((src) => `<button type="button" data-source="${esc(src)}" class="${src === s.selectedSource ? 'active' : ''}">${esc(sourceLabels[src] || src)}</button>`).join('')}</div>
          <button type="button" class="admin-icon-btn admin-access-btn" id="open-access-btn" title="Who has access" aria-label="Who has access">${icon('group')}</button>
        </div>
        ${s.tables.length ? `<div class="table-tabs">${sourceTables.map((t) => `<button type="button" data-table="${esc(t.name)}" class="${t.name === s.selectedTable ? 'active' : ''}">${esc(titleize(t.rawName || t.name))}</button>`).join('')}</div>` : ''}
        ${s.sourceErrors ? Object.entries(s.sourceErrors).map(([src, msg]) => `<p class="hint" style="color:var(--warning);">${esc(sourceLabels[src] || src)} could not be reached: ${esc(msg)}</p>`).join('') : ''}
        ${s.errorMessage ? `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">Something went wrong</div><div class="hint">${esc(s.errorMessage)}</div></div>`
          : s.isLoading ? `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`
          : gridHtml()}
      </div>
      ${s.accessOpen ? accessModalHtml() : ''}
      ${s.confirmAccess ? confirmAccessHtml() : ''}
      ${s.confirmDeleteRow ? `
        <div class="modal-backdrop" id="delete-row-modal-backdrop">
          <div class="modal">
            <h2>Delete row</h2>
            <p>Delete this row from ${esc(titleize(s.rows.rawName || s.rows.table))}? This cannot be undone.</p>
            <div style="display:flex;justify-content:flex-end;gap:var(--sp-sm);margin-top:var(--sp-xl);">
              <button type="button" class="btn" id="cancel-delete-row-btn">Cancel</button>
              <button type="button" class="btn btn-danger" id="confirm-delete-row-btn">Delete</button>
            </div>
          </div>
        </div>
      ` : ''}
    `;
    try { wire(); } finally { rendering = false; }
  }

  // The grid is the normal page width and the page itself scrolls up and down (no second scrollbar inside it). The column headers
  // (with the undo/redo/refresh buttons above them) stay just under the top bar, and the sideways scrollbar stays at the bottom
  // of the window while the table is in view. The headers and the rows are two tables with the same fixed column widths, so they
  // line up; wire() keeps the header, the rows and the sideways scrollbar at the same scroll position.
  function gridHtml() {
    const table = s.rows;
    if (!table) return `<div class="empty-state">No table selected<div class="hint">Choose a table to inspect its rows.</div></div>`;
    const hidden = s.hiddenColumnsByTable[table.table] || new Set();
    const visibleColumns = table.columns.filter((c) => !hidden.has(c));
    const filterCount = Object.keys(s.filters).length;
    const ACTIONS_WIDTH = 76;
    const tableWidth = ACTIONS_WIDTH + visibleColumns.reduce((sum, col) => sum + columnWidth(col), 0);
    const colgroup = `<colgroup><col style="width:${ACTIONS_WIDTH}px;">${visibleColumns.map((col) => `<col style="width:${columnWidth(col)}px;">`).join('')}</colgroup>`;
    const tableStyle = `style="width:${tableWidth}px;"`;

    const headHtml = `
      <div class="admin-grid-head">
        <table class="admin-table" ${tableStyle}>
          ${colgroup}
          <thead>
            <tr>
              <th><span class="col-name">Actions</span></th>
              ${visibleColumns.map((col) => `
                <th data-sort="${esc(col)}">
                  <span class="col-name">${esc(titleize(col))}${s.sort && s.sort.column === col ? (s.sort.ascending ? ' ▲' : ' ▼') : ''}</span>
                  <input class="col-filter" data-filter="${esc(col)}" value="${esc(s.filters[col] || '')}" placeholder="Filter" />
                </th>
              `).join('')}
            </tr>
          </thead>
        </table>
      </div>`;

    let bodyHtml;
    if (!table.rows.length) {
      bodyHtml = `<div class="empty-state">${filterCount ? 'No matching rows' : `${esc(titleize(table.table))} is empty`}<div class="hint">${filterCount ? 'Clear the active filters to see this table again.' : 'This table does not have any rows yet.'}</div>${filterCount ? `<button type="button" class="btn btn-sm" id="clear-filters-empty-btn" style="margin-top:var(--sp-md);">Clear filters</button>` : ''}</div>`;
    } else {
      bodyHtml = `
        <div class="admin-grid-scroll">
          <table class="admin-table" ${tableStyle}>
            ${colgroup}
            <tbody>
              ${table.rows.map((row) => {
                const id = String(row[table.primaryKey]);
                return `
                  <tr data-row-id="${esc(id)}">
                    <td class="admin-actions-cell">
                      <button type="button" class="admin-icon-btn" data-view-row="${esc(id)}" title="View row details" aria-label="View row details">${icon('open_in_full')}</button>
                      <button type="button" class="admin-icon-btn" data-delete-row="${esc(id)}" title="${table.deletable ? 'Delete row' : 'Delete unavailable'}" aria-label="${table.deletable ? 'Delete row' : 'Delete unavailable'}" ${table.deletable ? '' : 'disabled'}>${icon('delete_outline')}</button>
                    </td>
                    ${visibleColumns.map((col) => `<td style="min-width:${columnWidth(col)}px;">${valueHtml(table, row, col, id, 'grid')}</td>`).join('')}
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div class="admin-hscroll" aria-hidden="true"><div style="width:${tableWidth}px;"></div></div>
      `;
    }

    return `
      <div class="admin-grid-wrap">
        <div class="admin-grid-sticky">
          <div class="admin-grid-toolbar">
            <div class="admin-history-btns">
              <button type="button" class="admin-icon-btn" id="undo-btn" title="Undo your last edit (Ctrl+Z)" aria-label="Undo" ${s.isSaving || !s.undoStack.length ? 'disabled' : ''}>${icon('undo')}</button>
              <button type="button" class="admin-icon-btn" id="redo-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" ${s.isSaving || !s.redoStack.length ? 'disabled' : ''}>${icon('redo')}</button>
              <button type="button" class="admin-icon-btn" id="refresh-tables-btn" title="Refresh rows" aria-label="Refresh rows" ${s.isLoading || s.isSaving || s.isRefreshingRows ? 'disabled' : ''}>${s.isRefreshingRows ? spinnerBtn(true, '', { dark: true }) : icon('refresh')}</button>
            </div>
            <div class="filter-chips" style="flex:1;">
              ${filterCount
                ? Object.entries(s.filters).map(([k, v]) => `<button type="button" class="chip selected" data-remove-filter="${esc(k)}" aria-label="Remove ${esc(titleize(k))} filter">${esc(titleize(k))}: ${esc(v)} <span class="x" aria-hidden="true">✕</span></button>`).join('') + `<button type="button" class="btn-link" id="clear-filters-btn">Clear filters</button>`
                : `<span class="hint">${esc(titleize(table.rawName))} · ${esc(totalText(table))}</span>`}
            </div>
            <div class="column-menu">
              <button type="button" class="admin-icon-btn" id="column-menu-btn" title="Show or hide columns">${icon('view_column_outlined')} Columns</button>
              ${s.columnMenuOpen ? `
                <div class="column-menu-list">
                  ${table.columns.map((col) => `<label><input type="checkbox" data-col-toggle="${esc(col)}" ${hidden.has(col) ? '' : 'checked'} /> ${esc(titleize(col))}</label>`).join('')}
                </div>
              ` : ''}
            </div>
          </div>
          ${headHtml}
          ${s.isRefreshingRows ? `<div style="height:2px;background:var(--accent);"></div>` : ''}
        </div>
        ${bodyHtml}
        <div class="admin-footer">
          <span>${table.totalRows > 0 ? `${table.rows.length.toLocaleString('en-US')} of ${esc(totalText(table))} loaded` : `${table.rows.length} rows loaded`}</span>
          <div style="flex:1;"></div>
          ${s.isLoadingMoreRows ? spinnerBtn(true, '', { dark: true }) : s.hasMoreRows ? `<button type="button" class="btn-link" id="load-more-btn">Load more ▾</button>` : ''}
        </div>
        ${selectedRow() ? rowDetailHtml(table, selectedRow()) : ''}
      </div>
    `;
  }

  // The same editing in both places: the grid and the expanded row. `where` keeps their edit boxes apart.
  function valueHtml(table, row, col, rowId, where) {
    const value = row[col];
    const editable = table.editableColumns.includes(col);
    const secret = table.secretColumns.includes(col);
    const saving = s.savingCellKeys.has(cellKey(table.table, rowId, col));
    const options = table.columnOptions[col];
    const key = `${where}::${rowId}::${col}`; // must match what the click handlers store in s.editingCell
    if (editable && !secret && !saving && options) {
      // A stored value that is not one of the known options is shown as the placeholder instead of a generic "Select".
      const hasMatch = value !== null && value !== undefined && options.includes(String(value));
      const placeholderLabel = value === null || value === undefined ? 'Select' : String(value);
      return `<select class="admin-cell-input" data-select-cell="${esc(key)}">
          <option value="" ${hasMatch ? '' : 'selected'}>${esc(placeholderLabel)}</option>
          ${options.map((o) => `<option value="${esc(o)}" ${String(value) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        </select>`;
    }
    if (s.editingCell === key) {
      return `<textarea class="admin-cell-input" rows="${where === 'panel' ? 3 : 1}" data-edit-input="${esc(key)}">${esc(displayValue(value))}</textarea>`;
    }
    if (!secret && typeof value === 'boolean') {
      const canEdit = editable && !saving;
      return `<span class="bool-pill ${value ? 't' : 'f'}" ${canEdit ? `data-toggle-bool="${esc(key)}" style="cursor:pointer;"` : ''}>${value}</span>${saving ? ' ⏳' : ''}`;
    }
    const canEdit = editable && !secret && !saving;
    const display = secret ? '[hidden]' : displayValue(value);
    return `<span class="admin-cell-value ${canEdit ? 'editable' : ''} ${value === null ? 'null-value' : ''} ${secret ? 'secret' : ''}" ${canEdit ? `data-start-edit="${esc(key)}"` : ''} ${where === 'panel' ? 'style="white-space:pre-wrap;"' : ''}>${esc(display)}</span>${saving ? ' ⏳' : ''}`;
  }
  /** The expanded row, looked up fresh so it shows each edit as soon as it is saved. */
  function selectedRow() {
    if (!s.selectedRowId || !s.rows) return null;
    return s.rows.rows.find((r) => String(r[s.rows.primaryKey]) === s.selectedRowId) || null;
  }
  /** "grid::<row id>::<column>" -> the row and column (a row id never contains "::"). */
  function parseKey(key) {
    const first = key.indexOf('::'); const last = key.lastIndexOf('::');
    return { where: key.slice(0, first), id: key.slice(first + 2, last), col: key.slice(last + 2) };
  }
  function rowById(id) { return s.rows ? s.rows.rows.find((r) => String(r[s.rows.primaryKey]) === id) : null; }

  function rowDetailHtml(table, row) {
    const id = String(row[table.primaryKey]);
    return `
      <div class="row-detail-panel">
        <div class="rd-head">
          <div style="flex:1;font-weight:700;">${esc(titleize(table.rawName))}</div>
          <button type="button" class="admin-icon-btn" id="close-detail-btn" title="Close" aria-label="Close">${icon('close')}</button>
        </div>
        <div class="rd-body">
          ${table.columns.map((col) => `<div class="rd-field"><label>${esc(titleize(col))}</label><div style="font-size:.85rem;">${valueHtml(table, row, col, id, 'panel')}</div></div>`).join('')}
        </div>
      </div>
    `;
  }

  function wire() {
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    const openAccess = document.getElementById('open-access-btn');
    if (openAccess) openAccess.addEventListener('click', () => { s.accessOpen = true; s.addError = null; render(); if (!s.access) loadAccess(); });
    const closeAccess = () => { s.accessOpen = false; render(); };
    const closeAccessBtn = document.getElementById('close-access-btn'); if (closeAccessBtn) closeAccessBtn.addEventListener('click', closeAccess);
    const accessBackdrop = document.getElementById('access-backdrop'); if (accessBackdrop) accessBackdrop.addEventListener('click', (e) => { if (e.target === accessBackdrop) closeAccess(); });
    const retryAccess = document.getElementById('retry-access-btn'); if (retryAccess) retryAccess.addEventListener('click', loadAccess);
    const addForm = document.getElementById('add-admin-form');
    if (addForm) {
      addForm.addEventListener('submit', addAdminPerson); submitOnEnter(addForm);
      addForm.querySelector('input[name="email"]').addEventListener('input', (e) => { s.addEmail = e.target.value; });
    }
    app.querySelectorAll('[data-remove-admin]').forEach((b) => b.addEventListener('click', () => { s.confirmAccess = { kind: 'remove', userId: b.dataset.removeAdmin, name: b.dataset.name }; render(); }));
    app.querySelectorAll('[data-promote-admin]').forEach((b) => b.addEventListener('click', () => { s.confirmAccess = { kind: 'promote', userId: b.dataset.promoteAdmin, name: b.dataset.name }; render(); }));
    const cancelAccess = document.getElementById('cancel-access-btn'); if (cancelAccess) { cancelAccess.addEventListener('click', () => { s.confirmAccess = null; render(); }); cancelAccess.focus(); }
    const confirmAccessBtn = document.getElementById('confirm-access-btn'); if (confirmAccessBtn) confirmAccessBtn.addEventListener('click', confirmAccessChange);
    const confirmBackdrop = document.getElementById('confirm-access-backdrop'); if (confirmBackdrop) confirmBackdrop.addEventListener('click', (e) => { if (e.target === confirmBackdrop && !s.isAccessBusy) { s.confirmAccess = null; render(); } });
    const undoBtn = document.getElementById('undo-btn'); if (undoBtn) undoBtn.addEventListener('click', undo);
    const redoBtn = document.getElementById('redo-btn'); if (redoBtn) redoBtn.addEventListener('click', redo);
    const refreshBtn = document.getElementById('refresh-tables-btn'); if (refreshBtn) refreshBtn.addEventListener('click', () => (s.selectedTable ? refreshRows({ announce: true }) : loadTables()));
    app.querySelectorAll('[data-source]').forEach((btn) => btn.addEventListener('click', () => selectSource(btn.dataset.source)));
    app.querySelectorAll('[data-table]').forEach((btn) => btn.addEventListener('click', () => selectTable(btn.dataset.table)));
    app.querySelectorAll('[data-sort]').forEach((th) => th.addEventListener('click', (e) => { if (e.target.closest('input')) return; handleSortChanged(th.dataset.sort); }));
    app.querySelectorAll('[data-filter]').forEach((input) => {
      input.addEventListener('input', (e) => {
        s.activeFilter = { column: input.dataset.filter, value: e.target.value, start: e.target.selectionStart, end: e.target.selectionEnd };
        handleFilterChanged(input.dataset.filter, e.target.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finishFilter(input.dataset.filter, input.value); input.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); s.activeFilter = null; input.blur(); }
      });
      input.addEventListener('focus', () => { if (!rendering) s.activeFilter = { column: input.dataset.filter, value: input.value, start: input.selectionStart, end: input.selectionEnd }; });
      input.addEventListener('blur', () => { if (!rendering && s.activeFilter && s.activeFilter.column === input.dataset.filter) s.activeFilter = null; });
      // Typing in a column filter must not also sort the column (the header cell is the sort button). Done here, not
      // as an inline click attribute, because the page's Content-Security-Policy forbids inline handlers.
      input.addEventListener('click', (e) => e.stopPropagation());
    });
    const clearBtn = document.getElementById('clear-filters-btn'); if (clearBtn) clearBtn.addEventListener('click', clearFilters);
    const clearBtn2 = document.getElementById('clear-filters-empty-btn'); if (clearBtn2) clearBtn2.addEventListener('click', clearFilters);
    app.querySelectorAll('[data-remove-filter]').forEach((chip) => chip.addEventListener('click', () => removeFilter(chip.dataset.removeFilter)));
    const colMenuBtn = document.getElementById('column-menu-btn'); if (colMenuBtn) colMenuBtn.addEventListener('click', () => { s.columnMenuOpen = !s.columnMenuOpen; render(); });
    app.querySelectorAll('[data-col-toggle]').forEach((cb) => cb.addEventListener('change', (e) => {
      const col = cb.dataset.colToggle; const hidden = s.hiddenColumnsByTable[s.rows.table] || new Set();
      if (e.target.checked) hidden.delete(col); else hidden.add(col);
      s.hiddenColumnsByTable[s.rows.table] = hidden; render();
    }));
    app.querySelectorAll('[data-view-row]').forEach((btn) => btn.addEventListener('click', () => { s.selectedRowId = btn.dataset.viewRow; s.editingCell = null; render(); }));
    const closeDetail = document.getElementById('close-detail-btn'); if (closeDetail) closeDetail.addEventListener('click', () => { s.selectedRowId = null; s.editingCell = null; render(); });
    app.querySelectorAll('[data-delete-row]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.deleteRow;
      const row = s.rows.rows.find((r) => String(r[s.rows.primaryKey]) === id);
      if (row) deleteRow(row);
    }));
    const loadMoreBtn = document.getElementById('load-more-btn'); if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMoreRows);
    // Sideways scrolling: the rows (scrolled by trackpad, touch or shift+wheel), the header (scrolled when a filter box takes
    // focus) and the scrollbar pinned to the bottom of the window all follow each other. The position survives a redraw.
    const gridScroll = app.querySelector('.admin-grid-scroll');
    const gridHead = app.querySelector('.admin-grid-head');
    const hScroll = app.querySelector('.admin-hscroll');
    const scrollers = [gridScroll, gridHead, hScroll].filter(Boolean);
    const follow = (source) => {
      const x = source.scrollLeft; s.gridScrollLeft = x;
      scrollers.forEach((el) => { if (el !== source && el.scrollLeft !== x) el.scrollLeft = x; });
    };
    scrollers.forEach((el) => { el.scrollLeft = s.gridScrollLeft; el.addEventListener('scroll', () => follow(el)); });
    if (hScroll && gridScroll) hScroll.hidden = gridScroll.scrollWidth <= gridScroll.clientWidth + 1;
    setTopbarHeight();
    const cancelDeleteRow = document.getElementById('cancel-delete-row-btn'); if (cancelDeleteRow) cancelDeleteRow.addEventListener('click', () => { s.confirmDeleteRow = null; render(); });
    const confirmDeleteRowBtn = document.getElementById('confirm-delete-row-btn'); if (confirmDeleteRowBtn) confirmDeleteRowBtn.addEventListener('click', confirmDeleteRow);
    const deleteRowBackdrop = document.getElementById('delete-row-modal-backdrop');
    if (deleteRowBackdrop) deleteRowBackdrop.addEventListener('click', (e) => { if (e.target === deleteRowBackdrop) { s.confirmDeleteRow = null; render(); } });

    app.querySelectorAll('[data-start-edit]').forEach((el) => el.addEventListener('click', () => { s.editingCell = el.dataset.startEdit; render(); }));
    app.querySelectorAll('[data-edit-input]').forEach((ta) => {
      const commit = () => {
        const { id, col } = parseKey(ta.dataset.editInput);
        const row = rowById(id);
        if (row) editCell(row, col, ta.value); else { s.editingCell = null; render(); }
      };
      let cancelled = false;
      ta.addEventListener('blur', () => { if (!cancelled && !rendering) commit(); });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; s.editingCell = null; render(); } // leave without saving
      });
    });
    // A cell that has just been opened for editing takes the keyboard, with its text selected.
    const openEditor = app.querySelector('[data-edit-input]');
    if (openEditor) { openEditor.focus(); openEditor.select(); }
    app.querySelectorAll('[data-toggle-bool]').forEach((el) => el.addEventListener('click', () => {
      const { id, col } = parseKey(el.dataset.toggleBool);
      const row = rowById(id);
      if (row) toggleBool(row, col);
    }));
    app.querySelectorAll('[data-select-cell]').forEach((sel) => sel.addEventListener('change', (e) => {
      const { id, col } = parseKey(sel.dataset.selectCell);
      const row = rowById(id);
      if (row && e.target.value) editCell(row, col, e.target.value);
    }));
    // The filter being typed in keeps the keyboard (and the cursor where it was) when the rows update under it.
    if (s.activeFilter && !openEditor) {
      const box = [...app.querySelectorAll('[data-filter]')].find((i) => i.dataset.filter === s.activeFilter.column);
      if (box) {
        box.focus({ preventScroll: true });
        const end = box.value.length;
        try { box.setSelectionRange(Math.min(s.activeFilter.start ?? end, end), Math.min(s.activeFilter.end ?? end, end)); } catch { /* not a text box */ }
      }
    }
  }

  // Ask first: someone who is not an administrator sees a plain refusal, never the tables (the server refuses them anyway).
  try { s.me = await api('/admin/me'); } catch (err) {
    reportHandledException(err, 'adminMe');
    app.innerHTML = `<div class="page"><div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">This page could not load</div><div class="hint">${esc(friendlyError(err, 'Please try again.'))}</div></div></div>`;
    return;
  }
  if (!isCurrent()) return;
  if (!s.me.isAdmin) {
    app.innerHTML = `<div class="page"><div class="page-head-row"><div class="head-text"><h1>API Library</h1></div></div>${tabsHtml('/developer/admin')}<div class="empty-state">${icon('lock')}<div style="margin-top:var(--sp-md);">Not available</div><div class="hint">This page is only for Desk administrators.</div></div></div>`;
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    return;
  }
  // The grid's sticky header sits just under the top bar, whose height depends on the window width.
  function setTopbarHeight() {
    const bar = document.querySelector('.topbar');
    if (bar && !bar.hidden) document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
  }
  // The page scrolls (not the grid), so more rows load when the window nears the bottom of the page (240px, as the Flutter grid
  // did). A resize may add or remove the need for the sideways scrollbar. Both listeners remove themselves once the page is left.
  const onWindowScroll = () => {
    if (!isCurrent()) { window.removeEventListener('scroll', onWindowScroll); return; }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240) loadMoreRows();
  };
  const onWindowResize = () => {
    if (!isCurrent()) { window.removeEventListener('resize', onWindowResize); return; }
    setTopbarHeight();
    const gridScroll = app.querySelector('.admin-grid-scroll'); const hScroll = app.querySelector('.admin-hscroll');
    if (gridScroll && hScroll) hScroll.hidden = gridScroll.scrollWidth <= gridScroll.clientWidth + 1;
  };
  const onKeyDown = (e) => {
    if (!isCurrent()) { document.removeEventListener('keydown', onKeyDown); return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target;
    if (t && (t.closest?.('input, textarea, select, [contenteditable="true"]'))) return; // the box's own undo
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  };
  window.addEventListener('scroll', onWindowScroll, { passive: true });
  window.addEventListener('resize', onWindowResize);
  document.addEventListener('keydown', onKeyDown);
  render();
  await loadTables();
});
