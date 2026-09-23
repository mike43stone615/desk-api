// Administration (Desk administrators only): flip between the Desk, Registry and Market APIs and edit their data, and (for the
// owner) choose who else may see this page. Data comes from /admin/tables (src/routes/admin.ts), who has access from /admin/access.
// The tab is only shown to administrators and every request is checked again on the server; hiding is a convenience, not the lock.
import { registerRoute, api, esc, spinnerBtn, toast, icon, friendlyError, ADMIN_FILTER_DEBOUNCE_MS, reportHandledException, navigate, statusMsg, submitOnEnter, currentEpoch } from '../app.js';
import { tabsHtml } from '../tabs.js';

const ROWS_PAGE_SIZE = 100;

function titleize(value) {
  const spaced = value.replace(/\./g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return spaced.split('_').filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
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
    me: null, view: 'data', access: null, accessError: null, isAccessLoading: false,
    addEmail: '', addNote: '', addError: null, isAdding: false, confirmRemove: null, isRemoving: false,
    tables: [], rows: null, selectedTable: null, selectedSource: 'desk',
    errorMessage: null, isLoading: true, isSaving: false,
    undoStack: [], redoStack: [], savingCellKeys: new Set(),
    filters: {}, sort: null, hiddenColumnsByTable: {},
    hasMoreRows: false, isLoadingMoreRows: false, isRefreshingRows: false,
    selectedRow: null, columnMenuOpen: false, editingCell: null, confirmDeleteRow: null,
  };
  let filterDebounce = null;

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
      s.undoStack = []; s.redoStack = [];
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
    };
  }
  function hasMore(rows) { return rows ? rows.rows.length < rows.totalRows : false; }
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
    s.selectedTable = table; s.isLoading = true; s.errorMessage = null;
    s.filters = {}; s.sort = null; s.undoStack = []; s.redoStack = []; s.selectedRow = null;
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
  async function refreshRows() {
    if (!s.selectedTable) return;
    s.isRefreshingRows = true; render();
    try {
      const nextRows = await fetchRows(s.selectedTable, { limit: ROWS_PAGE_SIZE, filters: s.filters, sort: s.sort });
      s.rows = nextRows; s.hasMoreRows = hasMore(nextRows);
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
      s.rows = { ...s.rows, rows: [...s.rows.rows, ...next.rows], totalRows: next.totalRows };
      s.hasMoreRows = s.rows.rows.length < next.totalRows;
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
      await api(`/admin/tables/${change.table}/rows/${change.id}`, { method: 'PATCH', body: { values: { [change.column]: value } } });
      if (s.rows && s.rows.table === change.table) {
        s.rows = { ...s.rows, rows: s.rows.rows.map((r) => (String(r[s.rows.primaryKey]) === change.id ? { ...r, [change.column]: value } : r)) };
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
  async function undo() {
    if (!s.undoStack.length || s.isSaving) return;
    const change = s.undoStack.pop();
    await applyChange(change, false);
    if (!s.errorMessage) { s.redoStack.push(change); render(); }
  }
  async function redo() {
    if (!s.redoStack.length || s.isSaving) return;
    const change = s.redoStack.pop();
    await applyChange(change, true);
    if (!s.errorMessage) { s.undoStack.push(change); render(); }
  }
  function deleteRow(row) {
    if (!s.rows || !s.rows.deletable) return;
    s.confirmDeleteRow = row;
    render();
  }
  async function confirmDeleteRow() {
    const row = s.confirmDeleteRow;
    if (!s.rows || !row) return;
    const id = row[s.rows.primaryKey];
    s.confirmDeleteRow = null;
    try {
      await api(`/admin/tables/${s.rows.table}/rows/${id}`, { method: 'DELETE' });
      s.undoStack = []; s.redoStack = [];
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
      await api('/admin/access', { method: 'POST', body: { email: s.addEmail.trim(), note: s.addNote.trim() || undefined } });
      s.addEmail = ''; s.addNote = '';
      toast('Added. They can see the Administration tab the next time they open the page.');
      s.access = await api('/admin/access');
    } catch (err) {
      reportHandledException(err, 'addAdmin');
      s.addError = friendlyError(err, 'We could not add that person.');
    } finally { s.isAdding = false; if (isCurrent()) render(); }
  }
  async function removeAdminPerson() {
    const target = s.confirmRemove;
    if (!target || s.isRemoving) return;
    s.isRemoving = true; render();
    try {
      await api(`/admin/access/${encodeURIComponent(target.userId)}`, { method: 'DELETE' });
      toast('Access removed.');
      s.access = await api('/admin/access');
    } catch (err) {
      reportHandledException(err, 'removeAdmin');
      toast(friendlyError(err, 'We could not remove that person.'), true);
    } finally { s.confirmRemove = null; s.isRemoving = false; if (isCurrent()) render(); }
  }
  function accessHtml() {
    if (s.isAccessLoading && !s.access) return `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`;
    if (s.accessError) return `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">The list could not load</div><div class="hint">${esc(s.accessError)}</div><button type="button" class="btn" id="retry-access-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    const a = s.access || { owners: [], admins: [] };
    const isOwner = s.me && s.me.isOwner;
    const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
    return `
      <div class="card" style="margin-bottom:var(--sp-lg);">
        <h2 class="biz-section-title">Who can see this page</h2>
        <p class="biz-sub">Administrators can view and edit the data of every API here and use the other administrator tools. Only an owner can change this list. A person needs a Desk account with a confirmed email address, and must have signed in within the last 24 hours to use the tools.</p>
        <div class="field-header"><label>Owners (set in the server settings, cannot be removed here)</label></div>
        ${a.owners.map((o) => `<div class="state-card key-card"><div class="biz-icon neutral">${icon('lock')}</div><div class="biz-body"><div class="biz-title">${esc(o)}</div><div class="biz-sub">Owner</div></div></div>`).join('') || '<p class="biz-sub">None set.</p>'}
      </div>
      <div class="card" style="margin-bottom:var(--sp-lg);">
        <h2 class="biz-section-title">Administrators you added</h2>
        ${a.admins.length ? a.admins.map((p) => `
          <div class="state-card key-card">
            <div class="biz-icon neutral">${icon('group')}</div>
            <div class="biz-body">
              <div class="biz-title">${esc(`${p.firstName} ${p.lastName}`.trim() || p.email)}</div>
              <div class="biz-sub">${esc(p.email)} · added ${esc(when(p.addedAt))}${p.addedBy ? ` by ${esc(p.addedBy)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</div>
            </div>
            ${isOwner ? `<button type="button" class="btn btn-sm" data-remove-admin="${esc(p.userId)}" data-name="${esc(p.email)}" aria-label="Remove ${esc(p.email)}">Remove</button>` : ''}
          </div>`).join('') : `<div class="state-card"><div class="biz-body"><div class="biz-title">Nobody yet</div><div class="biz-sub">Only the owner can see this page.</div></div></div>`}
      </div>
      ${isOwner ? `
        <div class="card">
          <h2 class="biz-section-title">Add someone</h2>
          <p class="biz-sub" style="margin-bottom:var(--sp-md);">They must already have a Desk account (with a confirmed email address). Nobody is emailed.</p>
          <form id="add-admin-form" novalidate>
            <div class="field-float has-icon"><span class="field-icon">${icon('person_add')}</span><label>E-mail address</label><input name="email" type="email" placeholder=" " value="${esc(s.addEmail)}" autocomplete="off" /></div>
            <div class="field-float has-icon"><span class="field-icon">${icon('group')}</span><label>Note (optional, only you see it)</label><input name="note" placeholder=" " maxlength="200" value="${esc(s.addNote)}" autocomplete="off" /></div>
            ${s.addError ? statusMsg('error', s.addError, true) : ''}
            <button type="submit" class="btn btn-primary" style="margin-top:var(--sp-md);" ${s.isAdding ? 'disabled' : ''}>${s.isAdding ? spinnerBtn(true, '') : `${icon('person_add')} Give access`}</button>
          </form>
        </div>` : `<p class="biz-sub">Only an owner can add or remove administrators.</p>`}`;
  }

  function render() {
    if (!isCurrent()) return; // a page the person has already left must not draw over the new one
    const sources = [...new Set(s.tables.map((t) => t.source))];
    const sourceLabels = { desk: 'Desk API', registry: 'Registry API', market: 'Market API', compliance: 'Compliance (retired)' };
    const sourceTables = s.tables.filter((t) => t.source === s.selectedSource);

    const dataView = s.view === 'data';
    app.innerHTML = `
      <div class="page">
        <div class="page-head-row">
          <div class="head-text"><h1>API Library</h1><p>Administration: view and edit the data behind each API.</p></div>
          ${dataView ? `<div style="display:flex;gap:var(--sp-xs);">
            <button type="button" class="admin-icon-btn" id="undo-btn" title="Undo" aria-label="Undo" ${s.isSaving || !s.undoStack.length ? 'disabled' : ''}>${icon('undo')}</button>
            <button type="button" class="admin-icon-btn" id="redo-btn" title="Redo" aria-label="Redo" ${s.isSaving || !s.redoStack.length ? 'disabled' : ''}>${icon('redo')}</button>
            <button type="button" class="admin-icon-btn" id="refresh-tables-btn" title="Refresh tables" aria-label="Refresh tables" ${s.isLoading || s.isSaving ? 'disabled' : ''}>${icon('refresh')}</button>
          </div>` : ''}
        </div>
        ${tabsHtml('/developer/admin')}
        <div class="source-tabs" role="tablist" aria-label="Administration sections">
          <button type="button" data-view="data" class="${dataView ? 'active' : ''}">Data</button>
          <button type="button" data-view="access" class="${dataView ? '' : 'active'}">Who has access</button>
        </div>
        ${dataView ? `
          ${s.tables.length ? `
            <div class="source-tabs" aria-label="API">${sources.map((src) => `<button type="button" data-source="${esc(src)}" class="${src === s.selectedSource ? 'active' : ''}">${esc(sourceLabels[src] || src)}</button>`).join('')}</div>
            <div class="table-tabs">${sourceTables.map((t) => `<button type="button" data-table="${esc(t.name)}" class="${t.name === s.selectedTable ? 'active' : ''}">${esc(titleize(t.rawName || t.name))}</button>`).join('')}</div>
          ` : ''}
          ${s.sourceErrors ? Object.entries(s.sourceErrors).map(([src, msg]) => `<p class="hint" style="color:var(--warning);">${esc(sourceLabels[src] || src)} could not be reached: ${esc(msg)}</p>`).join('') : ''}
          ${s.errorMessage ? `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">Something went wrong</div><div class="hint">${esc(s.errorMessage)}</div></div>`
            : s.isLoading ? `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`
            : gridHtml()}
        ` : accessHtml()}
      </div>
      ${s.confirmRemove ? `<div class="modal-backdrop" id="remove-admin-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="remove-admin-title"><h2 id="remove-admin-title">Remove access</h2><p>Take away administrator access from ${esc(s.confirmRemove.email)}? It stops at once.</p><div style="display:flex;justify-content:flex-end;gap:var(--sp-sm);margin-top:var(--sp-xl);"><button type="button" class="btn" id="cancel-remove-admin-btn" ${s.isRemoving ? 'disabled' : ''}>Cancel</button><button type="button" class="btn btn-danger" id="confirm-remove-admin-btn" ${s.isRemoving ? 'disabled' : ''}>${s.isRemoving ? spinnerBtn(true, '') : 'Remove'}</button></div></div></div>` : ''}
      ${s.confirmDeleteRow ? `
        <div class="modal-backdrop" id="delete-row-modal-backdrop">
          <div class="modal">
            <h2>Delete row</h2>
            <p>Delete ${esc(titleize(s.rows.table))}.${esc(s.confirmDeleteRow[s.rows.primaryKey])}?</p>
            <div style="display:flex;justify-content:flex-end;gap:var(--sp-sm);margin-top:var(--sp-xl);">
              <button type="button" class="btn" id="cancel-delete-row-btn">Cancel</button>
              <button type="button" class="btn btn-danger" id="confirm-delete-row-btn">Delete</button>
            </div>
          </div>
        </div>
      ` : ''}
    `;
    wire();
  }

  function gridHtml() {
    const table = s.rows;
    if (!table) return `<div class="empty-state">No table selected<div class="hint">Choose a table to inspect its rows.</div></div>`;
    const hidden = s.hiddenColumnsByTable[table.table] || new Set();
    const visibleColumns = table.columns.filter((c) => !hidden.has(c));
    const filterCount = Object.keys(s.filters).length;

    let bodyHtml;
    if (!table.rows.length) {
      bodyHtml = `<div class="empty-state">${filterCount ? 'No matching rows' : `${esc(titleize(table.table))} is empty`}<div class="hint">${filterCount ? 'Clear the active filters to see this table again.' : 'This table does not have any rows yet.'}</div>${filterCount ? `<button type="button" class="btn btn-sm" id="clear-filters-empty-btn" style="margin-top:var(--sp-md);">Clear filters</button>` : ''}</div>`;
    } else {
      bodyHtml = `
        <div class="admin-grid-scroll">
          <table class="admin-table">
            <thead>
              <tr>
                <th style="width:76px;">Actions</th>
                ${visibleColumns.map((col) => `
                  <th data-sort="${esc(col)}" style="min-width:${columnWidth(col)}px;">
                    <span class="col-name">${esc(titleize(col))}${s.sort && s.sort.column === col ? (s.sort.ascending ? ' ▲' : ' ▼') : ''}</span>
                    <input class="col-filter" data-filter="${esc(col)}" value="${esc(s.filters[col] || '')}" placeholder="Filter" />
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${table.rows.map((row) => {
                const id = String(row[table.primaryKey]);
                return `
                  <tr data-row-id="${esc(id)}">
                    <td class="admin-actions-cell">
                      <button type="button" class="admin-icon-btn" data-view-row="${esc(id)}" title="View row details" aria-label="View row details">${icon('open_in_full')}</button>
                      <button type="button" class="admin-icon-btn" data-delete-row="${esc(id)}" title="${table.deletable ? 'Delete row' : 'Delete unavailable'}" aria-label="${table.deletable ? 'Delete row' : 'Delete unavailable'}" ${table.deletable ? '' : 'disabled'}>${icon('delete_outline')}</button>
                    </td>
                    ${visibleColumns.map((col) => cellHtml(table, row, col, id)).join('')}
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    return `
      <div class="admin-grid-wrap">
        <div class="admin-grid-toolbar">
          <div class="filter-chips" style="flex:1;">
            ${filterCount
              ? Object.entries(s.filters).map(([k, v]) => `<button type="button" class="chip selected" data-remove-filter="${esc(k)}" aria-label="Remove ${esc(titleize(k))} filter">${esc(titleize(k))}: ${esc(v)} <span class="x" aria-hidden="true">✕</span></button>`).join('') + `<button type="button" class="btn-link" id="clear-filters-btn">Clear filters</button>`
              : `<span class="hint">${esc(titleize(table.rawName))} · ${table.totalRows} rows</span>`}
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
        ${s.isRefreshingRows ? `<div style="height:2px;background:var(--accent);"></div>` : ''}
        ${bodyHtml}
        <div class="admin-footer">
          <span>${table.totalRows > 0 ? `${table.rows.length} of ${table.totalRows} rows loaded` : `${table.rows.length} rows loaded`}</span>
          <div style="flex:1;"></div>
          ${s.isLoadingMoreRows ? spinnerBtn(true, '', { dark: true }) : s.hasMoreRows ? `<button type="button" class="btn-link" id="load-more-btn">Load more ▾</button>` : ''}
        </div>
        ${s.selectedRow ? rowDetailHtml(table, s.selectedRow) : ''}
      </div>
    `;
  }

  function cellHtml(table, row, col, rowId) {
    const value = row[col];
    const editable = table.editableColumns.includes(col);
    const secret = table.secretColumns.includes(col);
    const saving = s.savingCellKeys.has(cellKey(table.table, rowId, col));
    const options = table.columnOptions[col];
    // Must match the `${id}::${col}` format the click handler stores in s.editingCell.
    const editKey = `${rowId}::${col}`;
    if (editable && !secret && !saving && options) {
      // If the stored value isn't one of the known options, show it as the
      // placeholder label instead of a generic "Select" so it isn't lost
      // from view — matches the Flutter grid's DropdownButtonFormField hint.
      const hasMatch = value !== null && value !== undefined && options.includes(String(value));
      const placeholderLabel = value === null || value === undefined ? 'Select' : String(value);
      return `<td style="min-width:${columnWidth(col)}px;">
        <select class="admin-cell-input" data-select-cell="${esc(rowId)}::${esc(col)}">
          <option value="" ${hasMatch ? '' : 'selected'}>${esc(placeholderLabel)}</option>
          ${options.map((o) => `<option value="${esc(o)}" ${String(value) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        </select>
      </td>`;
    }
    if (s.editingCell === editKey) {
      return `<td style="min-width:${columnWidth(col)}px;">
        <textarea class="admin-cell-input" rows="2" data-edit-input="${esc(rowId)}::${esc(col)}">${esc(displayValue(value))}</textarea>
      </td>`;
    }
    if (!secret && typeof value === 'boolean') {
      const canEdit = editable && !saving;
      return `<td style="min-width:${columnWidth(col)}px;"><span class="bool-pill ${value ? 't' : 'f'}" ${canEdit ? `data-toggle-bool="${esc(rowId)}::${esc(col)}" style="cursor:pointer;"` : ''}>${value}</span>${saving ? ' ⏳' : ''}</td>`;
    }
    const canEdit = editable && !secret && !saving;
    const display = secret ? '[hidden]' : displayValue(value);
    return `<td style="min-width:${columnWidth(col)}px;">
      <span class="admin-cell-value ${canEdit ? 'editable' : ''} ${value === null ? 'null-value' : ''} ${secret ? 'secret' : ''}" ${canEdit ? `data-start-edit="${esc(rowId)}::${esc(col)}"` : ''}>${esc(display)}</span>${saving ? ' ⏳' : ''}
    </td>`;
  }

  function rowDetailHtml(table, row) {
    return `
      <div class="row-detail-panel">
        <div class="rd-head">
          <div style="flex:1;font-weight:700;">${esc(titleize(table.rawName))} · ${esc(String(row[table.primaryKey]))}</div>
          <button type="button" class="admin-icon-btn" id="close-detail-btn" title="Close" aria-label="Close">${icon('close')}</button>
        </div>
        <div class="rd-body">
          ${table.columns.map((col) => {
            const secret = table.secretColumns.includes(col);
            const value = row[col];
            return `<div class="rd-field"><label>${esc(titleize(col))}</label>${secret ? '<div class="hint">[hidden]</div>' : typeof value === 'boolean' ? `<span class="bool-pill ${value ? 't' : 'f'}">${value}</span>` : `<div style="white-space:pre-wrap;font-size:.85rem;">${esc(displayValue(value))}</div>`}</div>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  function wire() {
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    app.querySelectorAll('[data-view]').forEach((btn) => btn.addEventListener('click', () => {
      s.view = btn.dataset.view; render();
      if (s.view === 'access' && !s.access) loadAccess();
    }));
    const retryAccess = document.getElementById('retry-access-btn'); if (retryAccess) retryAccess.addEventListener('click', loadAccess);
    const addForm = document.getElementById('add-admin-form');
    if (addForm) {
      addForm.addEventListener('submit', addAdminPerson); submitOnEnter(addForm);
      addForm.querySelector('input[name="email"]').addEventListener('input', (e) => { s.addEmail = e.target.value; });
      addForm.querySelector('input[name="note"]').addEventListener('input', (e) => { s.addNote = e.target.value; });
    }
    app.querySelectorAll('[data-remove-admin]').forEach((b) => b.addEventListener('click', () => { s.confirmRemove = { userId: b.dataset.removeAdmin, email: b.dataset.name }; render(); }));
    const cancelRemove = document.getElementById('cancel-remove-admin-btn'); if (cancelRemove) { cancelRemove.addEventListener('click', () => { s.confirmRemove = null; render(); }); cancelRemove.focus(); }
    const confirmRemoveBtn = document.getElementById('confirm-remove-admin-btn'); if (confirmRemoveBtn) confirmRemoveBtn.addEventListener('click', removeAdminPerson);
    const removeBackdrop = document.getElementById('remove-admin-backdrop'); if (removeBackdrop) removeBackdrop.addEventListener('click', (e) => { if (e.target === removeBackdrop && !s.isRemoving) { s.confirmRemove = null; render(); } });
    const undoBtn = document.getElementById('undo-btn'); if (undoBtn) undoBtn.addEventListener('click', undo);
    const redoBtn = document.getElementById('redo-btn'); if (redoBtn) redoBtn.addEventListener('click', redo);
    const refreshBtn = document.getElementById('refresh-tables-btn'); if (refreshBtn) refreshBtn.addEventListener('click', loadTables);
    app.querySelectorAll('[data-source]').forEach((btn) => btn.addEventListener('click', () => selectSource(btn.dataset.source)));
    app.querySelectorAll('[data-table]').forEach((btn) => btn.addEventListener('click', () => selectTable(btn.dataset.table)));
    app.querySelectorAll('[data-sort]').forEach((th) => th.addEventListener('click', (e) => { if (e.target.closest('input')) return; handleSortChanged(th.dataset.sort); }));
    app.querySelectorAll('[data-filter]').forEach((input) => {
      input.addEventListener('input', (e) => handleFilterChanged(input.dataset.filter, e.target.value));
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
    app.querySelectorAll('[data-view-row]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.viewRow;
      s.selectedRow = s.rows.rows.find((r) => String(r[s.rows.primaryKey]) === id) || null;
      render();
    }));
    const closeDetail = document.getElementById('close-detail-btn'); if (closeDetail) closeDetail.addEventListener('click', () => { s.selectedRow = null; render(); });
    app.querySelectorAll('[data-delete-row]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.deleteRow;
      const row = s.rows.rows.find((r) => String(r[s.rows.primaryKey]) === id);
      if (row) deleteRow(row);
    }));
    const loadMoreBtn = document.getElementById('load-more-btn'); if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMoreRows);
    // Auto-load near the bottom, matching the Flutter grid's ScrollController
    // threshold (240px from the end) — loadMoreRows() already no-ops when
    // already loading or there's nothing more, so this is safe to call often.
    const gridScroll = app.querySelector('.admin-grid-scroll');
    if (gridScroll) {
      gridScroll.addEventListener('scroll', () => {
        if (gridScroll.scrollTop + gridScroll.clientHeight >= gridScroll.scrollHeight - 240) loadMoreRows();
      });
    }
    const cancelDeleteRow = document.getElementById('cancel-delete-row-btn'); if (cancelDeleteRow) cancelDeleteRow.addEventListener('click', () => { s.confirmDeleteRow = null; render(); });
    const confirmDeleteRowBtn = document.getElementById('confirm-delete-row-btn'); if (confirmDeleteRowBtn) confirmDeleteRowBtn.addEventListener('click', confirmDeleteRow);
    const deleteRowBackdrop = document.getElementById('delete-row-modal-backdrop');
    if (deleteRowBackdrop) deleteRowBackdrop.addEventListener('click', (e) => { if (e.target === deleteRowBackdrop) { s.confirmDeleteRow = null; render(); } });

    app.querySelectorAll('[data-start-edit]').forEach((el) => el.addEventListener('click', () => { s.editingCell = el.dataset.startEdit; render(); }));
    app.querySelectorAll('[data-edit-input]').forEach((ta) => {
      const commit = () => {
        const [id, col] = ta.dataset.editInput.split('::');
        const row = s.rows.rows.find((r) => String(r[s.rows.primaryKey]) === id);
        if (row) editCell(row, col, ta.value); else { s.editingCell = null; render(); }
      };
      let cancelled = false;
      ta.addEventListener('blur', () => { if (!cancelled) commit(); });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; s.editingCell = null; render(); } // leave without saving
      });
    });
    // A cell that has just been opened for editing takes the keyboard, with its text selected.
    const openEditor = app.querySelector('[data-edit-input]');
    if (openEditor) { openEditor.focus(); openEditor.select(); }
    app.querySelectorAll('[data-toggle-bool]').forEach((el) => el.addEventListener('click', () => {
      const [id, col] = el.dataset.toggleBool.split('::');
      const row = s.rows.rows.find((r) => String(r[s.rows.primaryKey]) === id);
      if (row) toggleBool(row, col);
    }));
    app.querySelectorAll('[data-select-cell]').forEach((sel) => sel.addEventListener('change', (e) => {
      const [id, col] = sel.dataset.selectCell.split('::');
      const row = s.rows.rows.find((r) => String(r[s.rows.primaryKey]) === id);
      if (row && e.target.value) editCell(row, col, e.target.value);
    }));
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
  render();
  await loadTables();
});
