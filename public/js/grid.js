/* 布局引擎: 盒子网格 · 拖拽换位 · 多屏弹出 · 布局预设 */
import { S, bus, persist, BC, OID, guardWrite, toast } from './core.js';
import { h, cardShell } from './ui.js';

/* 24 列网格, span = [列数, 行数] */
export const LAYOUTS = {
  watch: [
    ['indices', 24, 1],
    ['watchlist', 5, 4], ['kline', 9, 4], ['heatmap', 10, 4],
    ['structure', 8, 3], ['radar', 8, 3], ['corr', 8, 3],
    ['movers', 6, 3], ['worldclock', 6, 3], ['news', 6, 3], ['alerts', 6, 3],
    ['quant', 8, 2], ['agent', 8, 2], ['screener', 8, 2],
  ],
  research: [
    ['kline', 13, 5], ['quant', 11, 5],
    ['radar', 12, 4], ['structure', 12, 4],
    ['corr', 8, 3], ['screener', 8, 3], ['news', 8, 3],
    ['system', 24, 1],
  ],
  tv1: [
    ['indices', 24, 1],
    ['heatmap', 15, 6], ['radar', 9, 3], ['movers', 9, 3],
  ],
  tv2: [
    ['kline', 14, 6], ['structure', 10, 3], ['watchlist', 10, 3],
  ],
  mobile: [
    ['indices', 24, 1],
    ['kline', 24, 3], ['watchlist', 24, 3], ['structure', 24, 3], ['heatmap', 24, 3],
    ['radar', 24, 4], ['movers', 24, 3], ['corr', 24, 3],
    ['worldclock', 24, 2], ['news', 24, 3], ['alerts', 24, 2], ['agent', 24, 2],
  ],
};
const CARD_SEQ = { n: 0 };
export const registry = new Map();   // type -> def {title, init, badge}
export const cards = [];             // [{id, type, el, api}]
export let gridEl;

export function initGrid(el) {
  gridEl = el;
  bus.on('layout.set', name => setLayout(name));
  bus.on('layout.open', (type, span) => openCard(type, span));
  bus.on('layout.close', id => closeCard(id));
  bus.on('layout.changed', () => render());
}

export function currentLayout() {
  if (S.layoutName === 'custom' && S.customLayout) return S.customLayout;
  const base = LAYOUTS[S.layoutName] || LAYOUTS.watch;
  // 恢复用户在盯盘布局下的排序调整 (仅顺序, 不改尺寸)
  if (S.layoutName === 'watch' && S.customLayout) {
    const order = new Map(S.customLayout.map((c, i) => [c[0], i]));
    return [...base].sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99));
  }
  return base;
}

export function setLayout(name, from = 'local') {
  if (!LAYOUTS[name] && name !== 'custom') return;
  // 配置锁: hard 全拦 / soft 拦远程; 恢复默认与撤销已在上层过锁, 这里不会再误伤
  if (name !== S.layoutName) {
    const reason = guardWrite(from);
    if (reason) { toast('🔒 ' + reason, 4000); return; }
  }
  S.layoutName = name;
  persist('layoutName', name);
  cards.slice().forEach(c => destroyCard(c));
  cards.length = 0;
  render();
  bus.emit('layout.set.done', name);
}

export function render() {
  gridEl.innerHTML = '';
  for (const [type, c, r] of currentLayout()) {
    if (!c) continue;
    const card = cards.find(x => x.type === type) || createCard(type);
    if (!card) continue;
    card.el.style.gridColumn = `span ${c}`;
    card.el.style.gridRow = `span ${r}`;
    gridEl.appendChild(card.el);
  }
  // 未进布局的卡片销毁
  const inLayout = new Set(currentLayout().filter(x => x[1]).map(x => x[0]));
  cards.filter(c => !inLayout.has(c.type)).forEach(destroyCard);
}

export function createCard(type) {
  const def = registry.get(type);
  if (!def) return null;
  const el = h('div', { class: 'card', 'data-type': type });
  const card = { id: 'card-' + (++CARD_SEQ.n), type, el, def, api: {} };
  cards.push(card);
  // 框架统一创建卡片外壳 (标题栏 + .card-bd), 插件只管填充 card.bd
  const ctx = { popout: t => popout(t), closeCard: id => closeCard(id) };
  try { cardShell(card, def, ctx); } catch {}
  try { def.init(card); } catch (e) {
    console.error('[card]', type, e);
    const bd = el.querySelector('.card-bd');
    if (bd) bd.innerHTML = `<div class="hint">卡片加载失败: ${e.message}<br>${String(e.stack || '').slice(0, 200)}</div>`;
  }
  wireDrag(card);
  return card;
}
export function openCard(type, span) {
  const exists = cards.find(c => c.type === type);
  if (exists) return exists;
  const card = createCard(type);
  if (!card) return null;
  const [c, r] = span || [6, 3];
  card.el.style.gridColumn = `span ${c}`;
  card.el.style.gridRow = `span ${r}`;
  gridEl.appendChild(card.el);
  bus.emit('card.opened', card);
  return card;
}
function destroyCard(card) {
  try { card.api.destroy?.(); } catch {}
  card.el.remove();
  cards.splice(cards.indexOf(card), 1);
}
export function closeCard(idOrType) {
  const c = cards.find(x => x.id === idOrType || x.type === idOrType);
  if (c) { destroyCard(c); persistCustom(); }
}

/* ---------- 多屏弹出 ---------- */
export function popout(type) {
  window.open(`${location.pathname}?pop=${type}&theme=${S.theme}`, 'if-pop-' + type,
    `width=720,height=480,left=${(screen.width - 720) / 2},top=${(screen.height - 480) / 2}`);
}

/* ---------- 编辑模式拖拽换位 ---------- */
function wireDrag(card) {
  const hd = card.el.querySelector('.card-hd');
  hd.addEventListener('mousedown', e => {
    if (!S.edit || e.target.closest('.cop')) return;
    const reason = guardWrite('local');
    if (reason) { toast('🔒 ' + reason, 4000); return; }   // 全锁定时不让拖动改布局
    e.preventDefault();
    card.el.classList.add('dragging');
    const move = ev => {
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.card');
      document.querySelectorAll('.card.drop-target').forEach(x => x.classList.remove('drop-target'));
      if (over && over !== card.el) over.classList.add('drop-target');
    };
    const up = ev => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      card.el.classList.remove('dragging');
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.card');
      document.querySelectorAll('.card.drop-target').forEach(x => x.classList.remove('drop-target'));
      if (over && over !== card.el) {
        const lay = currentLayout();
        const i = lay.findIndex(x => x[0] === card.type);
        const j = lay.findIndex(x => x[0] === over.dataset.type);
        if (i >= 0 && j >= 0) {
          const keepA = lay[i][1], keepB = lay[j][1];
          lay[i][1] = keepB; lay[i][2] = lay[i][2];
          lay[j][1] = keepA;
          S.customLayout = lay.map(x => [...x]);
          S.layoutName = 'watch'; // 保持盯盘为基, 记录顺序
          persist('customLayout', S.customLayout);
          render();
        }
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
function persistCustom() {
  if (S.layoutName !== 'watch') return;
  S.customLayout = currentLayout().map(x => [...x]);
  persist('customLayout', S.customLayout);
}

/* ---------- 插件注册 ---------- */
export function registerCard(def) { registry.set(def.type, def); }
