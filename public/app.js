'use strict';

/* ==================== 全局状态 ==================== */

let state = { props: [], records: [], verification: null, warehouse: '仓库' };
let editingPropId = null;
let editingRecordId = null;

const $ = (sel) => document.querySelector(sel);
const els = {
  whName: $('#wh-name'),
  summary: $('#summary'),
  orphanBanner: $('#orphan-banner'),
  propResults: $('#prop-results'),
  propTableBody: document.querySelector('#prop-table tbody'),
  recordTableBody: document.querySelector('#record-table tbody'),
  propDialog: $('#prop-dialog'),
  recordDialog: $('#record-dialog'),
  propForm: $('#prop-form'),
  recordForm: $('#record-form'),
  propTitle: $('#prop-dialog-title'),
  recordTitle: $('#record-dialog-title'),
  propId: $('#prop-id'),
  propName: $('#prop-name'),
  propNote: $('#prop-note'),
  recordId: $('#record-id'),
  recordProp: $('#record-prop'),
  recordMinute: $('#record-minute'),
  recordFrom: $('#record-from'),
  recordTo: $('#record-to'),
  recordNote: $('#record-note'),
  peopleList: $('#people-list'),
  toast: $('#toast'),
  // 现场盘点
  btnInventory: $('#btn-inventory'),
  invDialog: $('#inventory-dialog'),
  invForm: $('#inventory-form'),
  invMinuteInput: $('#inv-minute-input'),
  invRows: $('#inv-rows'),
  btnInvAddRow: $('#btn-inv-addrow'),
  btnInvFillProps: $('#btn-inv-fillprops'),
  propNameList: $('#prop-name-list'),
  invPanel: $('#inventory-panel'),
  invMinuteLabel: $('#inv-minute'),
  invSummary: $('#inv-summary'),
  invBannerOk: $('#inv-banner-ok'),
  invTableBody: document.querySelector('#inv-table tbody'),
  btnInvClose: $('#btn-inv-close'),
};

const STATUS_TEXT = {
  RETURNED: { cls: 'badge-ok', text: '✓ 已归仓' },
  NOT_RETURNED: { cls: 'badge-warn', text: '⚠ 演出结束未归仓' },
  CONFLICT: { cls: 'badge-error', text: '✕ 交接链冲突' },
  NO_RECORDS: { cls: 'badge-muted', text: '— 无交接记录' },
};

/* ==================== API ==================== */

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `请求失败（${res.status}）`);
  return body;
}

async function loadState() {
  state = await api('/api/state');
  render();
}

/* ==================== 渲染：汇总 ==================== */

function renderSummary() {
  const s = state.verification.summary;
  $('#stat-total').textContent = s.totalProps;
  $('#stat-returned').textContent = s.returned;
  $('#stat-conflict').textContent = s.conflicts;
  $('#stat-notreturned').textContent = s.notReturned;
  $('#stat-norecords').textContent = s.noRecords;
  $('#stat-endminute').textContent = s.endMinute;

  if (state.verification.orphanRecords.length) {
    const ids = state.verification.orphanRecords.map((r) => shortId(r.id)).join('、');
    els.orphanBanner.textContent =
      `数据异常：有 ${state.verification.orphanRecords.length} 条交接记录引用了不存在的道具（记录编号 ${ids}），` +
      '这些记录未参与核验，请删除或更正。';
    els.orphanBanner.classList.remove('hidden');
  } else {
    els.orphanBanner.classList.add('hidden');
  }
}

/* ==================== 渲染：核验卡片 + 时间轴 ==================== */

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shortId(id) {
  return String(id).replace(/^[a-z]+_/, '').slice(0, 6);
}

function segClass(seg) {
  if (seg.conflictMinute != null) return 'seg-conflict';
  if (seg.open) return 'seg-open';
  return seg.holder === state.warehouse ? 'seg-warehouse' : 'seg-person';
}

function renderTimeline(timeline, endMinute) {
  const segs = timeline.segments || [];
  if (segs.length === 0) return '';

  // 时间跨度；所有段按时长比例分配宽度（最小宽度 34px，见 CSS）
  const maxEnd = Math.max(endMinute, ...segs.map((s) => s.endMinute), 1);
  const parts = segs.map((s) => Math.max(s.endMinute - s.startMinute, 0));
  const totalDur = parts.reduce((a, b) => a + b, 0) || parts.length;

  const track = segs.map((s, idx) => {
    const dur = s.endMinute - s.startMinute;
    const flex = parts[idx] || 0;
    const tip = s.conflictMinute != null
      ? `第${s.conflictMinute}分钟发生冲突，持有人「${s.holder}」的去向无法确定`
      : s.open
        ? `持有人：${s.holder}；第${s.startMinute}分钟持有至演出第${s.endMinute}分钟结束，仍未归仓`
        : `持有人：${s.holder}；第${s.startMinute}–${s.endMinute}分钟，持有时长 ${dur} 分钟`;
    return `<div class="tl-seg ${segClass(s)}" style="flex:${flex} 1 0" title="${esc(tip)}">${esc(s.holder)}</div>`;
  }).join('');

  // 轴刻度：沿用相同的 flex 比例，在每段下显示起止分钟
  const axis = segs.map((s, idx) =>
    `<div class="tl-tick" style="flex:${parts[idx] || 0} 1 0;min-width:34px">第${s.startMinute}分${
      idx === segs.length - 1 ? ` … 第${s.endMinute}分` : ''
    }</div>`
  ).join('');

  return `
    <div class="timeline">
      <div class="timeline-track">${track}</div>
      <div class="tl-axis">${axis}</div>
      <div class="tl-legend">
        <span><i style="background:#6b7280"></i>仓库持有</span>
        <span><i style="background:var(--accent)"></i>人员持有</span>
        <span><i style="background:repeating-linear-gradient(45deg,#c5850a,#c5850a 5px,#d99b20 5px,#d99b20 10px)"></i>结束未归仓</span>
        <span><i style="background:repeating-linear-gradient(45deg,#b42318,#b42318 5px,#d05046 5px,#d05046 10px)"></i>冲突点</span>
      </div>
    </div>`;
}

function renderChain(result) {
  const chain = result.chain;
  const nodes = [`<span class="chain-node">${esc(state.warehouse)}</span>`];
  chain.forEach((r) => {
    nodes.push(
      `<span class="chain-arrow">→</span><span class="chain-node">${esc(r.to)}</span>` +
      `<span class="chain-meta">[第${r.minute}分 · ${shortId(r.id)}]</span>`
    );
  });
  if (result.status === 'CONFLICT') {
    nodes.push(`<span class="chain-arrow">→</span><span class="chain-node" style="color:var(--error)">✕ 第${result.conflict.minute}分钟断裂</span>`);
  }
  return `<div class="chain">${nodes.join(' ')}</div>`;
}

function renderConflictBox(result) {
  const c = result.conflict;
  if (!c) return '';
  const links = c.recordRefs
    .map((r) => `<a data-record-id="${esc(r.id)}">记录 ${shortId(r.id)}</a>`)
    .join('、');
  const typeText = c.type === 'AMBIGUOUS' ? '多条可接续记录（交接链不唯一）' : '剩余记录无法接续（断链）';
  return `
    <div class="conflict-box">
      <div class="conflict-head">冲突类型：${typeText} · 第${c.minute}分钟</div>
      <div>${esc(c.reason)}</div>
      <div style="margin-top:4px">定位记录：${links}（已在右下表中红色标出）</div>
    </div>`;
}

function renderResultCard(result) {
  const prop = state.props.find((p) => p.id === result.propId);
  if (!prop) return '';
  const badge = STATUS_TEXT[result.status];

  let line;
  if (result.status === 'RETURNED') {
    line = `交接链完整，共重放 <strong>${result.replayedCount}</strong> 条记录，道具已归仓。`;
  } else if (result.status === 'NOT_RETURNED') {
    line = `交接链可完整重放（<strong>${result.replayedCount}</strong> 条），但演出至第<strong>${state.verification.endMinute}</strong>分钟结束时，道具仍由 <strong>「${esc(result.holder)}」</strong>持有，<strong>未归仓</strong>。`;
  } else if (result.status === 'CONFLICT') {
    line = `已重放 <strong>${result.replayedCount}</strong> / ${result.totalCount} 条记录后，在第<strong>${result.conflict.minute}</strong>分钟发生冲突，剩余 ${result.totalCount - result.replayedCount} 条记录无法继续核验。`;
  } else {
    line = '该道具没有任何交接记录，演出全程留在仓库。';
  }

  return `
    <article class="result-card st-${result.status}" data-prop-id="${esc(prop.id)}">
      <div class="card-title">
        <h3>${esc(prop.name)}</h3>
        <span class="badge ${badge.cls}">${badge.text}</span>
        ${prop.note ? `<span class="card-note">${esc(prop.note)}</span>` : ''}
      </div>
      <div class="card-line">${line}</div>
      ${renderConflictBox(result)}
      ${renderTimeline(result.timeline, state.verification.endMinute)}
      ${renderChain(result)}
    </article>`;
}

function renderResults() {
  const order = { CONFLICT: 0, NOT_RETURNED: 1, RETURNED: 2, NO_RECORDS: 3 };
  const results = [...state.verification.results].sort(
    (a, b) => order[a.status] - order[b.status]
  );
  els.propResults.innerHTML = results.map(renderResultCard).join('');
}

/* ==================== 渲染：道具表 / 记录表 ==================== */

function renderPropTable() {
  if (state.props.length === 0) {
    els.propTableBody.innerHTML = `<tr><td colspan="3" class="empty">还没有道具，点击右上角「录入道具」开始</td></tr>`;
    return;
  }
  els.propTableBody.innerHTML = state.props.map((p) => {
    const count = state.records.filter((r) => r.propId === p.id).length;
    return `<tr data-prop-id="${esc(p.id)}">
      <td><strong>${esc(p.name)}</strong><div class="name-sub">${count} 条交接记录</div></td>
      <td>${esc(p.note)}</td>
      <td class="col-actions">
        <button class="btn btn-sm" data-edit-prop="${esc(p.id)}">修改</button>
        <button class="btn btn-sm btn-danger" data-del-prop="${esc(p.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
}

function conflictRecordIds() {
  const set = new Set();
  state.verification.results.forEach((r) => {
    if (r.conflict) r.conflict.records.forEach((id) => set.add(id));
  });
  state.verification.orphanRecords.forEach((r) => set.add(r.id));
  return set;
}

function renderRecordTable() {
  if (state.records.length === 0) {
    els.recordTableBody.innerHTML = `<tr><td colspan="6" class="empty">还没有交接记录，点击右上角「录入交接记录」开始</td></tr>`;
    return;
  }
  const propName = (id) => {
    const p = state.props.find((x) => x.id === id);
    return p ? p.name : '⚠ 道具已删除';
  };
  const bad = conflictRecordIds();
  const sorted = [...state.records].sort((a, b) =>
    a.minute - b.minute || (a.createdAt || 0) - (b.createdAt || 0) ||
    String(a.id).localeCompare(String(b.id))
  );
  els.recordTableBody.innerHTML = sorted.map((r) => `
    <tr data-record-id="${esc(r.id)}" class="${bad.has(r.id) ? 'row-conflict' : ''}">
      <td class="cell-minute">第${r.minute}分</td>
      <td>${esc(propName(r.propId))}</td>
      <td>${esc(r.from)}</td>
      <td>${esc(r.to)}</td>
      <td>${esc(r.note)}</td>
      <td class="col-actions">
        <button class="btn btn-sm" data-edit-record="${esc(r.id)}">修改</button>
        <button class="btn btn-sm btn-danger" data-del-record="${esc(r.id)}">删除</button>
      </td>
    </tr>`).join('');
}

function renderPeopleList() {
  const names = new Set();
  state.records.forEach((r) => { names.add(r.from); names.add(r.to); });
  els.peopleList.innerHTML = [...names].map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function renderPropSelect() {
  els.recordProp.innerHTML = state.props
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');
}

function render() {
  els.whName.textContent = state.warehouse;
  renderSummary();
  renderResults();
  renderPropTable();
  renderRecordTable();
  renderPeopleList();
  renderPropSelect();
  renderPropNameList();
}

/* ==================== 弹窗 ==================== */

function openPropDialog(prop = null) {
  editingPropId = prop ? prop.id : null;
  els.propTitle.textContent = prop ? '修改道具' : '录入道具';
  els.propId.value = prop ? prop.id : '';
  els.propName.value = prop ? prop.name : '';
  els.propNote.value = prop ? prop.note || '' : '';
  els.propDialog.showModal();
  els.propName.focus();
}

function openRecordDialog(record = null) {
  if (state.props.length === 0) {
    toast('请先录入至少一件道具', true);
    return;
  }
  editingRecordId = record ? record.id : null;
  els.recordTitle.textContent = record ? '修改交接记录' : '录入交接记录';
  els.recordId.value = record ? record.id : '';
  els.recordProp.value = record ? record.propId : state.props[0].id;
  els.recordMinute.value = record ? record.minute : '';
  els.recordFrom.value = record ? record.from : '';
  els.recordTo.value = record ? record.to : '';
  els.recordNote.value = record ? record.note || '' : '';
  els.recordDialog.showModal();
  els.recordMinute.focus();
}

/* ==================== 交互 ==================== */

function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('toast-error', isError);
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), 2600);
}

async function safe(action, okMsg) {
  try {
    await action();
    await loadState();
    if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err.message, true);
  }
}

function bindEvents() {
  $('#btn-add-prop').addEventListener('click', () => openPropDialog());
  $('#btn-add-record').addEventListener('click', () => openRecordDialog());
  $('#btn-reverify').addEventListener('click', () =>
    safe(loadState, '已按时间重新重放全部交接记录，核验完成'));

  // 现场盘点
  els.btnInventory.addEventListener('click', openInventoryDialog);
  els.btnInvAddRow.addEventListener('click', () => {
    els.invRows.insertAdjacentHTML('beforeend', invRowHtml());
    els.invRows.querySelector('.inv-row:last-child .inv-name').focus();
  });
  els.btnInvFillProps.addEventListener('click', () => {
    // 以已登记道具为准补齐：保留已填写的行，再追加尚未出现的道具行（持有人留空待填）
    const filled = collectInvRows();
    const usedNames = new Set(filled.map((r) => r.name));
    const extra = state.props.filter((p) => !usedNames.has(p.name)).map((p) => invRowHtml(p.name, ''));
    els.invRows.innerHTML = filled.map((r) => invRowHtml(r.name, r.holder)).join('') + extra.join('');
    if (els.invRows.children.length === 0) resetInvRows();
  });
  els.invRows.addEventListener('click', (e) => {
    const del = e.target.closest?.('.inv-del');
    if (!del) return;
    if (els.invRows.children.length <= 1) {
      toast('至少保留一行；要放弃盘点请点「取消」', true);
      return;
    }
    del.closest('.inv-row').remove();
  });
  els.invForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitInventory();
  });
  els.btnInvClose.addEventListener('click', () => els.invPanel.classList.add('hidden'));

  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  els.propForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = { name: els.propName.value, note: els.propNote.value };
    els.propDialog.close();
    safe(async () => {
      if (editingPropId) await api(`/api/props/${editingPropId}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/props', { method: 'POST', body: JSON.stringify(payload) });
    }, editingPropId ? '道具已修改并重新核验' : '道具已录入并重新核验');
  });

  els.recordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = {
      propId: els.recordProp.value,
      minute: Number(els.recordMinute.value),
      from: els.recordFrom.value.trim(),
      to: els.recordTo.value.trim(),
      note: els.recordNote.value,
    };
    els.recordDialog.close();
    safe(async () => {
      if (editingRecordId) await api(`/api/records/${editingRecordId}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/records', { method: 'POST', body: JSON.stringify(payload) });
    }, editingRecordId ? '记录已修改并重新核验' : '记录已录入并重新核验');
  });

  // 事件委托：表格内的编辑 / 删除，以及冲突记录定位
  document.addEventListener('click', (e) => {
    const t = e.target;

    const editProp = t.closest?.('[data-edit-prop]');
    if (editProp) {
      const p = state.props.find((x) => x.id === editProp.dataset.editProp);
      if (p) openPropDialog(p);
      return;
    }
    const delProp = t.closest?.('[data-del-prop]');
    if (delProp) {
      const p = state.props.find((x) => x.id === delProp.dataset.delProp);
      const count = state.records.filter((r) => r.propId === delProp.dataset.delProp).length;
      if (p && confirm(`确定删除道具「${p.name}」？其名下 ${count} 条交接记录将一并删除。`)) {
        safe(() => api(`/api/props/${p.id}`, { method: 'DELETE' }), '道具已删除并重新核验');
      }
      return;
    }
    const editRecord = t.closest?.('[data-edit-record]');
    if (editRecord) {
      const r = state.records.find((x) => x.id === editRecord.dataset.editRecord);
      if (r) openRecordDialog(r);
      return;
    }
    const delRecord = t.closest?.('[data-del-record]');
    if (delRecord) {
      if (confirm('确定删除这条交接记录？')) {
        safe(() => api(`/api/records/${delRecord.dataset.delRecord}`, { method: 'DELETE' }), '记录已删除并重新核验');
      }
      return;
    }
    const conflictLink = t.closest?.('[data-record-id]');
    if (conflictLink && t.closest('.conflict-box')) {
      locateRecord(conflictLink.dataset.recordId);
    }
  });
}

function locateRecord(id) {
  const row = document.querySelector(`tr[data-record-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // 重启动画
  row.classList.add('flash');
}

/* ==================== 现场盘点 ==================== */

const INV_STATUS_TEXT = {
  MATCH: { cls: 'inv-ok', text: '✓ 一致' },
  MISMATCH: { cls: 'inv-bad', text: '✕ 持有人不符' },
  UNKNOWN: { cls: 'inv-bad', text: '？ 无法判定' },
  UNREGISTERED: { cls: 'inv-warn', text: '账外' },
  DUPLICATE: { cls: 'inv-neutral', text: '重复录入' },
  MISSING: { cls: 'inv-muted', text: '未盘' },
};

let invResult = null;

function renderPropNameList() {
  els.propNameList.innerHTML = state.props
    .map((p) => `<option value="${esc(p.name)}"></option>`)
    .join('');
}

function invRowHtml(name = '', holder = '') {
  return `
    <div class="inv-row">
      <input type="text" class="inv-name" maxlength="40" placeholder="道具名称" list="prop-name-list" value="${esc(name)}" />
      <input type="text" class="inv-holder" maxlength="30" list="people-list" placeholder="实物持有人" value="${esc(holder)}" />
      <button type="button" class="btn btn-sm btn-danger inv-del" title="删除此行">✕</button>
    </div>`;
}

function resetInvRows() {
  els.invRows.innerHTML = [invRowHtml(), invRowHtml(), invRowHtml()].join('');
}

function openInventoryDialog() {
  els.invMinuteInput.value = state.verification.endMinute || 0;
  resetInvRows();
  els.invDialog.showModal();
  els.invMinuteInput.focus();
}

function collectInvRows() {
  return [...els.invRows.querySelectorAll('.inv-row')]
    .map((row) => ({
      name: row.querySelector('.inv-name').value.trim(),
      holder: row.querySelector('.inv-holder').value.trim(),
    }))
    .filter((r) => r.name || r.holder);
}

function renderInventoryResult(result) {
  invResult = result;
  els.invMinuteLabel.textContent = result.atMinute;

  const s = result.summary;
  const chips = [
    [`共 ${s.total} 行`, ''],
    [`一致 ${s.match}`, 'chip-ok'],
    [`持有人不符 ${s.mismatch}`, 'chip-bad'],
    [`无法判定 ${s.unknown}`, 'chip-bad'],
    [`账外 ${s.unregistered}`, 'chip-warn'],
    [`重复录入 ${s.duplicate}`, 'chip-neutral'],
    [`未盘 ${s.missing}`, 'chip-muted'],
    [`账实差异 ${s.discrepancy}`, s.discrepancy > 0 ? 'chip-bad' : 'chip-ok'],
  ];
  els.invSummary.innerHTML = chips
    .map(([text, cls]) => `<span class="inv-chip ${cls}">${text}</span>`)
    .join('');

  els.invBannerOk.classList.toggle('hidden', s.discrepancy !== 0);

  const order = { MISMATCH: 0, UNKNOWN: 1, UNREGISTERED: 2, MISSING: 3, DUPLICATE: 4, MATCH: 5 };
  const rows = [...result.rows].sort(
    (a, b) => order[a.status] - order[b.status] || (a.rowNo ?? 1e9) - (b.rowNo ?? 1e9)
  );

  els.invTableBody.innerHTML = rows.map((r) => {
    const st = INV_STATUS_TEXT[r.status];
    const dash = '<span class="inv-dash">—</span>';
    const rowNo = r.rowNo == null ? '<span class="inv-dash" title="系统补列的未盘道具">补列</span>' : r.rowNo;
    return `
      <tr class="inv-row-${r.status}">
        <td class="cell-minute">${rowNo}</td>
        <td><strong>${esc(r.name)}</strong></td>
        <td>${r.actualHolder == null ? dash : esc(r.actualHolder)}</td>
        <td>${r.bookHolder == null ? dash : esc(r.bookHolder)}</td>
        <td><span class="inv-badge ${st.cls}">${st.text}</span></td>
        <td class="inv-note">${esc(r.note)}</td>
      </tr>`;
  }).join('');

  els.invPanel.classList.remove('hidden');
  els.invPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitInventory() {
  const minute = Number(els.invMinuteInput.value);
  if (!Number.isInteger(minute) || minute < 0) {
    toast('盘点时刻必须是不小于 0 的整数（分钟）', true);
    return;
  }
  const rows = collectInvRows();
  if (rows.length === 0) {
    toast('请至少填写一行盘点记录（道具名称 + 实物持有人）', true);
    return;
  }
  const empty = rows.find((r) => !r.name || !r.holder);
  if (empty) {
    toast('每行的道具名称与实物持有人都必须填写；完全空白的行请删除', true);
    return;
  }

  try {
    const result = await api('/api/inventory/check', {
      method: 'POST',
      body: JSON.stringify({ minute, rows }),
    });
    els.invDialog.close();
    renderInventoryResult(result);
    toast('盘点完成（结果仅本次有效，未改动交接记录）');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ==================== 启动 ==================== */

bindEvents();
loadState().catch((err) => toast(`加载数据失败：${err.message}`, true));
