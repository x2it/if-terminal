/* DOM 工具 + 卡片外壳 */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat(9)) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 卡片外壳: 标题栏 + 操作按钮 (弹出/关闭) */
export function cardShell(card, def, ctx) {
  const hd = h('div', { class: 'card-hd' },
    h('span', { class: 'card-title' }, def.title),
    h('span', { class: 'card-badge', 'data-badge': '' }, def.badge || ''),
    h('div', { class: 'card-ops' },
      h('button', { class: 'cop', title: '弹出为独立窗口 (多屏)', onclick: () => ctx.popout(card.type) }, '⧉'),
      h('button', { class: 'cop', title: '刷新', onclick: () => card.api?.refresh?.() }, '⟳'),
      h('button', { class: 'cop', title: '关闭', onclick: () => ctx.closeCard(card.id) }, '✕'),
    ));
  const bd = h('div', { class: 'card-bd' + (def.pad === false ? '' : ' pad') });
  card.el.appendChild(hd);
  card.el.appendChild(bd);
  card.hd = hd; card.bd = bd;
  card.setBadge = t => { const b = hd.querySelector('[data-badge]'); if (b) b.textContent = t || ''; };
  return bd;
}

export function spark(canvas, data, color, { w = 64, h = 20, fill = true } = {}) {
  // 无论有无数据, 先固定画布尺寸, 避免默认 300x150 撑高表格行
  const dpr = devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  if (!data || data.length < 2) return;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  /* 不用 Math.min(...data): 扩展运算符把数组摊成参数, 序列一长就有爆调用栈的风险。
   * 迷你图数据虽短, 但这个渲染函数在报价推送里被高频调用, 不该留这种隐患。 */
  let min = Infinity, max = -Infinity;
  for (const v of data) { if (v < min) min = v; if (v > max) max = v; }
  const rng = (max - min) || 1;
  const X = i => i / (data.length - 1) * (w - 1);
  const Y = v => h - 2 - (v - min) / rng * (h - 4);
  g.beginPath();
  data.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)));
  g.strokeStyle = color; g.lineWidth = 1; g.stroke();
  if (fill) {
    g.lineTo(X(data.length - 1), h); g.lineTo(0, h); g.closePath();
    g.fillStyle = color + '22'; g.fill();
  }
}

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
