'use strict';

const express = require('express');
const path = require('path');

const store = require('./src/store');
const { verifyAll } = require('./src/verify');
const { checkInventory } = require('./src/inventory');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- 校验工具 ---------------- */

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function parseMinute(value, field) {
  if (value === undefined || value === null || value === '') throw new Error(`${field}不能为空`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${field}必须是不小于 0 的整数（分钟）`);
  return n;
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}不能为空`);
  return value.trim();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/* ---------------- 读取 / 核验 ---------------- */

app.get('/api/state', (req, res) => {
  const data = store.getData();
  res.json({ warehouse: store.WAREHOUSE, ...data, verification: verifyAll(data) });
});

app.get('/api/verify', (req, res) => {
  res.json(verifyAll(store.getData()));
});

/* ---------------- 现场盘点（只读，即时结果，不改写交接记录） ---------------- */

app.post('/api/inventory/check', asyncRoute((req, res) => {
  const body = req.body || {};

  let minute;
  try {
    minute = parseMinute(body.minute, '盘点时刻（分钟）');
  } catch (err) {
    return badRequest(res, err.message);
  }

  if (!Array.isArray(body.rows)) {
    return badRequest(res, '盘点行（rows）必须是数组');
  }
  if (body.rows.length === 0) {
    return badRequest(res, '请至少填写一行盘点记录');
  }
  if (body.rows.length > 500) {
    return badRequest(res, '单次盘点最多 500 行');
  }

  const rows = [];
  for (let i = 0; i < body.rows.length; i += 1) {
    const r = body.rows[i] || {};
    try {
      const name = nonEmpty(r.name, `第 ${i + 1} 行道具名称`);
      const holder = nonEmpty(r.holder, `第 ${i + 1} 行实物持有人`);
      if (name.length > 40) throw new Error(`第 ${i + 1} 行道具名称最长 40 个字符`);
      if (holder.length > 30) throw new Error(`第 ${i + 1} 行实物持有人最长 30 个字符`);
      rows.push({ name, holder });
    } catch (err) {
      return badRequest(res, err.message);
    }
  }

  // 纯读取 + 即时重放，不写入任何数据
  res.json(checkInventory(store.getData(), minute, rows));
}));

/* ---------------- 道具 CRUD ---------------- */

app.get('/api/props', (req, res) => {
  res.json(store.getData().props);
});

app.post('/api/props', asyncRoute((req, res) => {
  const body = req.body || {};
  let name;
  try {
    name = nonEmpty(body.name, '道具名称');
  } catch (err) {
    return badRequest(res, err.message);
  }
  const data = store.getData();
  if (data.props.some((p) => p.name === name)) {
    return badRequest(res, `已存在同名道具「${name}」`);
  }
  const prop = {
    id: store.newId('p'),
    name,
    note: typeof body.note === 'string' ? body.note.trim() : '',
    createdAt: Date.now(),
  };
  const props = [...data.props, prop];
  store.saveProps(props);
  res.status(201).json(prop);
}));

app.put('/api/props/:id', asyncRoute((req, res) => {
  const data = store.getData();
  const idx = data.props.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '道具不存在' });

  const body = req.body || {};
  let name;
  try {
    name = nonEmpty(body.name, '道具名称');
  } catch (err) {
    return badRequest(res, err.message);
  }
  if (data.props.some((p) => p.name === name && p.id !== req.params.id)) {
    return badRequest(res, `已存在同名道具「${name}」`);
  }
  const updated = {
    ...data.props[idx],
    name,
    note: typeof body.note === 'string' ? body.note.trim() : (data.props[idx].note || ''),
  };
  const props = data.props.map((p) => (p.id === updated.id ? updated : p));
  store.saveProps(props);
  res.json(updated);
}));

app.delete('/api/props/:id', (req, res) => {
  const data = store.getData();
  if (!data.props.some((p) => p.id === req.params.id)) {
    return res.status(404).json({ error: '道具不存在' });
  }
  // 删除道具时级联删除其全部交接记录
  const props = data.props.filter((p) => p.id !== req.params.id);
  const records = data.records.filter((r) => r.propId !== req.params.id);
  store.saveProps(props);
  store.saveRecords(records);
  res.status(204).end();
});

/* ---------------- 交接记录 CRUD ---------------- */

function validateRecord(body, data) {
  const minute = parseMinute(body.minute, '分钟');
  const from = nonEmpty(body.from, '交出者');
  const to = nonEmpty(body.to, '接收者');
  if (from === to) throw new Error('交出者与接收者不能相同');
  const propId = nonEmpty(body.propId, '道具');
  if (!data.props.some((p) => p.id === propId)) throw new Error('请选择已登记的道具');
  return {
    propId,
    minute,
    from,
    to,
    note: typeof body.note === 'string' ? body.note.trim() : '',
  };
}

app.get('/api/records', (req, res) => {
  res.json(store.getData().records);
});

app.post('/api/records', asyncRoute((req, res) => {
  const data = store.getData();
  let fields;
  try {
    fields = validateRecord(req.body || {}, data);
  } catch (err) {
    return badRequest(res, err.message);
  }
  const record = { id: store.newId('r'), ...fields, createdAt: Date.now() };
  store.saveRecords([...data.records, record]);
  res.status(201).json(record);
}));

app.put('/api/records/:id', asyncRoute((req, res) => {
  const data = store.getData();
  const idx = data.records.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '记录不存在' });

  let fields;
  try {
    fields = validateRecord(req.body || {}, data);
  } catch (err) {
    return badRequest(res, err.message);
  }
  // 修改保留原始录入顺序（createdAt），使同一分钟仍按最初录入先后重放
  const updated = { ...data.records[idx], ...fields };
  store.saveRecords(data.records.map((r) => (r.id === updated.id ? updated : r)));
  res.json(updated);
}));

app.delete('/api/records/:id', (req, res) => {
  const data = store.getData();
  if (!data.records.some((r) => r.id === req.params.id)) {
    return res.status(404).json({ error: '记录不存在' });
  }
  store.saveRecords(data.records.filter((r) => r.id !== req.params.id));
  res.status(204).end();
});

/* ---------------- 错误兜底 ---------------- */

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  // 启动时确保数据文件存在（首次启动写入初始数据）
  store.getData();
  console.log(`演出道具交接核验应用已启动: http://localhost:${PORT}`);
});
