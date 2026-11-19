// ball.js — floating ball renderer (no Node access; talks to ball-preload via window.ballServices)
const btnDissolve = document.getElementById('btn-dissolve');
const btnMerge = document.getElementById('btn-merge');
const btnClose = document.getElementById('btn-close');
const dragHandle = document.getElementById('drag-handle');
const statusEl = document.getElementById('status');
const counterEl = document.getElementById('counter');

let statusTimer = null;
let statusActive = false;

function showStatus(text, type = '') {
  statusEl.textContent = text;
  statusEl.className = 'status show ' + type;
  statusActive = true;
  // The bubble and the live counter share the same strip below the capsule —
  // show one at a time so the texts never overlap.
  counterEl.className = 'counter';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.className = 'status';
    statusActive = false;
    applySelection(lastSnapshot);
  }, 2600);
}

// ── live selection counter ──
// The watcher in ball-preload.js pushes a snapshot whenever the Explorer
// selection changes; we only show a hint, the operations always re-read.
let lastItems = [];

function applySelection(snapshot) {
  const items = (snapshot && snapshot.items) || [];
  lastItems = items;
  const folders = items.filter((i) => i.isFolder).length;

  if (statusActive) {
    // A result bubble is on screen — it owns the strip.
    counterEl.textContent = '';
    counterEl.className = 'counter';
  } else if (items.length === 0) {
    counterEl.textContent = '未选中';
    counterEl.className = 'counter';
  } else {
    counterEl.textContent = `已选 ${items.length} 项${folders ? ` · ${folders} 夹` : ''}`;
    counterEl.className = 'counter show';
  }

  btnDissolve.classList.toggle('ready', folders > 0);
  btnMerge.classList.toggle('ready', items.length >= 2);
  btnDissolve.classList.toggle('idle', folders === 0);
  btnMerge.classList.toggle('idle', items.length < 2);
}

window.addEventListener('ball-selection', (e) => {
  applySelection(e.detail);
});

// Initial state (the watcher may take a moment to report the first snapshot).
try {
  applySelection(window.ballServices.getSelectionSnapshot());
} catch (e) {}

// ── actions ──
btnClose.addEventListener('click', (e) => {
  e.stopPropagation();
  window.ballServices.requestClose();
});

btnDissolve.addEventListener('click', async (e) => {
  e.stopPropagation();
  btnDissolve.disabled = true;
  showStatus('读取选中项...');
  try {
    const sel = window.ballServices.readExplorerSelection();
    const folders = (sel.items || []).filter((i) => i.isFolder);
    if (folders.length === 0) {
      showStatus('没有选中的文件夹', 'error');
      return;
    }
    const r = window.ballServices.doDissolve(folders.map((f) => f.path));
    showStatus(r.message, r.success ? 'success' : 'error');
    applySelection({ items: [] });
  } catch (e) {
    showStatus('操作失败: ' + e.message, 'error');
  } finally {
    btnDissolve.disabled = false;
  }
});

btnMerge.addEventListener('click', async (e) => {
  e.stopPropagation();
  btnMerge.disabled = true;
  showStatus('读取选中项...');
  try {
    const sel = window.ballServices.readExplorerSelection();
    if (!sel.items || sel.items.length < 2) {
      showStatus('请至少选择两个项目', 'error');
      return;
    }
    const r = window.ballServices.doMerge(sel.items.map((i) => i.path));
    showStatus(r.message, r.success ? 'success' : 'error');
    applySelection({ items: [] });
  } catch (e) {
    showStatus('操作失败: ' + e.message, 'error');
  } finally {
    btnMerge.disabled = false;
  }
});

// ── drag ──
// The ball is a frameless, transparent, focusable:false window, so it is
// dragged with JS: the absolute screen coordinates of the pointer are sent to
// the parent window, which owns the BrowserWindow and calls setPosition.
let dragging = false;

function currentPoint() {
  try {
    const p = window.ballServices.getCursorPoint();
    return { x: p.x, y: p.y };
  } catch {
    return { x: 0, y: 0 };
  }
}

dragHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragging = true;
  const p = currentPoint();
  window.ballServices.requestDragStart(p.x, p.y);
  dragHandle.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', () => {
  if (!dragging) return;
  const p = currentPoint();
  window.ballServices.requestDragMove(p.x, p.y);
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  dragHandle.style.cursor = 'grab';
  window.ballServices.requestDragEnd();
});
