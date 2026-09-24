'use strict';

/**
 * 演出中途现场盘点（账实差异）引擎。
 *
 * 输入：盘点分钟（非负整数）+ 逐行填写的盘点行（道具名称、实物持有人）。
 * 输出：该时刻逐行 / 逐道具的账实差异结论。
 *
 * 账面口径（服务端即时重放，不改写任何交接记录）：
 * - 只重放「盘点分钟及以前」的交接记录，盘点分钟之后的记录一律忽略
 *   （因此较晚分钟的冲突不影响本次盘点）；
 * - 沿用核验引擎的同分钟唯一链规则（同分钟内按唯一出边归约）；
 * - 在该分钟的所有交接完成后取账面持有人；
 * - 该道具在此前（含本分钟）交接链出现冲突（多条可接续 / 断链）=> 无法判定。
 *
 * 分类规则（每行 / 每件道具唯一归类）：
 * - DUPLICATE   盘点行重名：每次出现单列为一行「重复录入」，不以后项覆盖前项；
 * - OFF_BOOK    盘点行填写了未登记名称 => 账外；
 * - NOT_COUNTED 已登记道具没有任何盘点行 => 未盘；
 * - UNDETERMINED 已登记道具在盘点分钟及以前交接链冲突 => 无法判定；
 * - MATCH       其余：实物持有人与账面持有人一致 => 一致；
 * - MISMATCH    其余：实物持有人与账面持有人不符 => 持有人不符（附账面持有人）。
 */

const { WAREHOUSE, replayRecords } = require('./verify');

const CATEGORY = {
  MATCH: 'MATCH',                 // 账实一致
  MISMATCH: 'MISMATCH',           // 持有人不符
  DUPLICATE: 'DUPLICATE',         // 重复录入
  OFF_BOOK: 'OFF_BOOK',           // 账外
  NOT_COUNTED: 'NOT_COUNTED',     // 未盘
  UNDETERMINED: 'UNDETERMINED',   // 无法判定
};

/**
 * 对一件已登记道具，重放盘点分钟及以前的记录，取账面状态。
 * 结果按 propId 缓存，重复盘点行与“未盘”道具共用。
 */
function bookStateFor(prop, allRecords, cutoffMinute) {
  const records = allRecords.filter(
    (r) => r.propId === prop.id && Number(r.minute) <= cutoffMinute
  );
  if (records.length === 0) {
    return { holder: WAREHOUSE, chain: [], conflict: null };
  }
  const replay = replayRecords(records);
  return { holder: replay.holder, chain: replay.chain, conflict: replay.conflict };
}

/**
 * 执行现场盘点。
 * @param {{props: Array, records: Array}} data 当前数据（只读，不修改）
 * @param {number} cutoffMinute 盘点分钟（非负整数）
 * @param {Array<{name: string, holder: string}>} rows 盘点行（名称、实物持有人均非空）
 */
function stocktake(data, cutoffMinute, rows) {
  const props = data.props || [];
  const records = data.records || [];

  const propByName = new Map(props.map((p) => [p.name, p]));
  const bookCache = new Map();
  const getBook = (prop) => {
    if (!bookCache.has(prop.id)) {
      bookCache.set(prop.id, bookStateFor(prop, records, cutoffMinute));
    }
    return bookCache.get(prop.id);
  };

  // 名称 -> 在盘点行中出现的行序号（1 起）；用于判定重名
  const nameLines = new Map();
  rows.forEach((row, idx) => {
    const line = idx + 1;
    if (!nameLines.has(row.name)) nameLines.set(row.name, []);
    nameLines.get(row.name).push(line);
  });

  const entries = [];
  const countedPropIds = new Set();

  // 1) 按盘点行顺序逐行归类（重名行各自单列，不覆盖）
  rows.forEach((row, idx) => {
    const line = idx + 1;
    const prop = propByName.get(row.name) || null;
    const lines = nameLines.get(row.name);
    const base = {
      line,
      propId: prop ? prop.id : null,
      propName: row.name,
      actualHolder: row.holder,
      bookHolder: null,
      registered: Boolean(prop),
      conflict: null,
      duplicate: null,
    };

    if (lines.length > 1) {
      base.duplicate = { index: lines.indexOf(line) + 1, total: lines.length };
      if (prop) {
        const book = getBook(prop);
        base.bookHolder = book.holder;
        base.conflict = book.conflict
          ? { type: book.conflict.type, minute: book.conflict.minute, holder: book.conflict.holder, reason: book.conflict.reason }
          : null;
      }
      entries.push({ ...base, category: CATEGORY.DUPLICATE });
      if (prop) countedPropIds.add(prop.id);
      return;
    }

    if (!prop) {
      entries.push({ ...base, category: CATEGORY.OFF_BOOK });
      return;
    }

    countedPropIds.add(prop.id);
    const book = getBook(prop);
    base.bookHolder = book.holder;
    if (book.conflict) {
      base.conflict = {
        type: book.conflict.type,
        minute: book.conflict.minute,
        holder: book.conflict.holder,
        reason: book.conflict.reason,
      };
      entries.push({ ...base, category: CATEGORY.UNDETERMINED });
      return;
    }

    const matched = row.holder === book.holder;
    entries.push({ ...base, category: matched ? CATEGORY.MATCH : CATEGORY.MISMATCH });
  });

  // 2) 已登记但未出现在任何盘点行的道具 => 未盘（排在盘点行结论之后，按登记顺序）
  props.forEach((prop) => {
    if (countedPropIds.has(prop.id)) return;
    const book = getBook(prop);
    entries.push({
      line: null,
      propId: prop.id,
      propName: prop.name,
      actualHolder: null,
      bookHolder: book.holder,
      registered: true,
      conflict: book.conflict
        ? { type: book.conflict.type, minute: book.conflict.minute, holder: book.conflict.holder, reason: book.conflict.reason }
        : null,
      duplicate: null,
      category: CATEGORY.NOT_COUNTED,
    });
  });

  const count = (cat) => entries.filter((e) => e.category === cat).length;
  const summary = {
    cutoffMinute,
    totalRows: rows.length,
    totalProps: props.length,
    match: count(CATEGORY.MATCH),
    mismatch: count(CATEGORY.MISMATCH),
    duplicate: count(CATEGORY.DUPLICATE),
    offBook: count(CATEGORY.OFF_BOOK),
    notCounted: count(CATEGORY.NOT_COUNTED),
    undetermined: count(CATEGORY.UNDETERMINED),
    hasDifference: entries.some((e) => e.category !== CATEGORY.MATCH),
  };

  return { warehouse: WAREHOUSE, cutoffMinute, entries, summary };
}

module.exports = { CATEGORY, stocktake };
