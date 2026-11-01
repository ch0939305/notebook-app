/* ===== 多功能筆記本 · 雲端同步版 =====
 * - 已設定 Supabase：auth 登入 + notes 表 CRUD + 即時同步（A 手機改，B 手機秒更新）
 * - 未設定 Supabase：自動退回 localStorage 單機模式
 * - 雲端載入後備份到 localStorage，離線/雲端故障時資料不遺失
 */
'use strict';

// ---------- 設定 / 初始化 ----------
const LS_NOTES = 'notebook:notes';
const LS_CATS = 'notebook:categories';
const LS_THEME = 'notebook:theme';
const LS_USER = 'notebook:user';
const LS_ACCT = 'notebook:accounts'; // 本機帳號（測試用）

// 預設分類（可自行新增 / 改名 / 刪除 / 排序）
const DEFAULT_CATS = [
  { id: 'personal', name: '個人' },
  { id: 'company', name: '公司' },
  { id: 'computer', name: '電腦' },
  { id: 'stocks', name: '股票' }
];
const UNCAT_ID = 'uncategorized';
const UNCAT_NAME = '未分類';

// 偵測是否已設定 Supabase
const hasCloudDB = (typeof SUPABASE_URL !== 'undefined')
  && SUPABASE_URL
  && !SUPABASE_URL.includes('your-project')
  && (typeof SUPABASE_ANON_KEY !== 'undefined')
  && SUPABASE_ANON_KEY
  && !SUPABASE_ANON_KEY.includes('your-anon-key');

let cloudRowId = null;

// 目前使用者
let currentUser = null;

// ---------- 工具函式 ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmtDate = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function readNotes() {
  try { return JSON.parse(localStorage.getItem(LS_NOTES)) || []; }
  catch { return []; }
}
function writeNotes(arr) {
  try { localStorage.setItem(LS_NOTES, JSON.stringify(arr)); } catch (e) {
    console.warn('本機備份失敗（容量可能不足）：', e.message);
  }
}

/* ---------- 分類存取 ---------- */
function readCats() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_CATS));
    if (Array.isArray(raw) && raw.length) return normalizeCats(raw);
  } catch (e) { /* 讀取失敗就用預設值 */ }
  return DEFAULT_CATS.map(c => ({ ...c, updatedAt: 0 }));
}
function normalizeCats(arr) {
  return arr
    .filter(c => c && (c.id || c.name))
    .map(c => ({
      id: String(c.id || ('c_' + uid())),
      name: String(c.name || '未命名'),
      updatedAt: Number(c.updatedAt) || 0
    }));
}
function writeCats(arr) {
  try { localStorage.setItem(LS_CATS, JSON.stringify(arr)); } catch (e) { /* 忽略 */ }
}
// 合併本機與雲端分類：id 相同取 updatedAt 較新者，其餘聯集
function mergeCats(localCats, cloudCats) {
  if (!Array.isArray(cloudCats) || !cloudCats.length) return localCats;
  const map = new Map();
  for (const c of normalizeCats(localCats)) map.set(c.id, c);
  for (const c of normalizeCats(cloudCats)) {
    const cur = map.get(c.id);
    if (!cur || (c.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(c.id, c);
  }
  return Array.from(map.values());
}
// 檢查下拉選單是否含有某個值
function hasOption(sel, val) {
  if (!sel) return false;
  for (let i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value === val) return true;
  }
  return false;
}
// 由 id 取顯示名稱
function catName(id) {
  if (!id || id === UNCAT_ID) return UNCAT_NAME;
  const c = state.categories.find(x => x.id === id);
  return c ? c.name : UNCAT_NAME;
}

// 雲端工具函式
async function cloudFetch(path, opts = {}) {
  if (!hasCloudDB) return null;
  const headers = { 'apikey': SUPABASE_ANON_KEY, ...opts.headers };
  try {
    const res = await fetch(SUPABASE_URL + path, { ...opts, headers });
    if (!res.ok) return null;
    if (res.status === 204) return true;
    return await res.json();
  } catch { return null; }
}

async function loadFromCloud() {
  if (!hasCloudDB) return null;
  const data = await cloudFetch(`/rest/v1/${STORAGE_TABLE}?select=id,data&data->>key=eq.${STORAGE_KEY}`);
  if (!data || data.length === 0) return null;
  cloudRowId = data[0].id;
  const d = data[0].data || {};
  return { notes: d.notes || null, categories: d.categories || null };
}

async function saveToCloud(notes, categories) {
  if (!hasCloudDB) return false;
  const payload = { data: { key: STORAGE_KEY, notes, categories: categories || [] } };
  if (cloudRowId) {
    const ok = await cloudFetch(`/rest/v1/${STORAGE_TABLE}?id=eq.${cloudRowId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return ok !== null;
  } else {
    const result = await cloudFetch(`/rest/v1/${STORAGE_TABLE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(payload)
    });
    if (result && result[0]) { cloudRowId = result[0].id; return true; }
    return false;
  }
}

// ---------- 主題 ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(LS_THEME, theme);
  const tg = $('theme-toggle');
  if (tg) tg.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ---------- 登入 / 註冊 ----------
function initAuth() {
  // 本機模式 - 直接進入 APP，不需登入
  currentUser = { email: 'local' };
  localStorage.setItem(LS_USER, 'local');
  enterApp();
}

function enterApp() {
  $('app-screen').classList.remove('hidden');
  initApp();
}

// ---------- 主應用 ----------
const state = { category: 'all', query: '', editingId: null, notes: [], categories: [] };

/* 統一刷新入口：所有資料變動後只呼叫這裡，渲染函式之間不互相呼叫 */
function refreshAll() {
  renderCategories();
  renderCategorySelect();
  renderNotes();
  updateFab();
}

let appInitialized = false;

function initApp() {
  if (appInitialized) return; // 防止重複綁定事件
  appInitialized = true;
  state.categories = readCats();
  bindAppEvents();
  loadNotes();
}

function bindAppEvents() {
  applyTheme(localStorage.getItem(LS_THEME) || 'light');
  $('theme-toggle').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  };
  $('search-input').addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderNotes();
  });

  $('btn-add').onclick = () => openModal(null);
  if ($('fab-add')) $('fab-add').onclick = () => openModal(null);

  // 分類管理
  $('btn-cat-manage').onclick = openCatManager;
  $('btn-cat-close').onclick = closeCatManager;
  $('cat-modal').addEventListener('click', (e) => {
    if (e.target === $('cat-modal')) closeCatManager();
  });
  $('btn-cat-add').onclick = addCategory;
  $('new-cat-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCategory(); }
  });

  $('btn-cancel').onclick = closeModal;
  $('note-modal').addEventListener('click', (e) => {
    if (e.target === $('note-modal')) closeModal();
  });
  $('note-form').addEventListener('submit', (e) => { e.preventDefault(); saveNote(); });

  $('note-image').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    // 預覽原圖
    $('image-preview').src = URL.createObjectURL(f);
    $('image-preview-wrap').classList.remove('hidden');
  });

  $('note-pdf').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      $('pdf-link').href = ev.target.result;
      $('pdf-link').textContent = '📄 開啟 PDF';
      $('pdf-preview-wrap').classList.remove('hidden');
    };
    reader.readAsDataURL(f);
  });
}

/* ---------- 分類列渲染（含「全部」） ---------- */
function renderCategories() {
  const bar = $('category-bar');
  if (!bar) return;

  const total = state.notes.length;
  const uncatCount = state.notes.filter(n => !n.category || !state.categories.some(c => c.id === n.category)).length;

  const items = [{ id: 'all', name: '全部', count: total }];
  state.categories.forEach(c => {
    items.push({ id: c.id, name: c.name, count: state.notes.filter(n => n.category === c.id).length });
  });
  if (uncatCount > 0) items.push({ id: UNCAT_ID, name: UNCAT_NAME, count: uncatCount });

  // 目前選取的分類若已不存在（被刪除），自動回到「全部」
  if (state.category !== 'all' && !items.some(i => i.id === state.category)) {
    state.category = 'all';
  }

  bar.innerHTML = items.map(i => `
    <button type="button" class="category-btn${i.id === state.category ? ' active' : ''}" data-category="${esc(i.id)}">
      ${esc(i.name)}<span class="count">${i.count}</span>
    </button>`).join('');

  bar.querySelectorAll('.category-btn').forEach(btn => {
    btn.onclick = () => {
      state.category = btn.dataset.category;
      renderCategories();
      renderNotes();
    };
  });
}

/* ---------- 筆記表單的分類下拉選單 ---------- */
function renderCategorySelect() {
  const sel = $('note-category');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = state.categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
    + `<option value="${UNCAT_ID}">${UNCAT_NAME}</option>`;
  if (keep && hasOption(sel, keep)) sel.value = keep;
  else if (state.category !== 'all' && hasOption(sel, state.category)) sel.value = state.category;
}

/* ---------- 分類管理 Modal ---------- */
function openCatManager() {
  renderCatManager();
  $('cat-modal').classList.remove('hidden');
}

function closeCatManager() {
  $('cat-modal').classList.add('hidden');
  $('new-cat-name').value = '';
}

function renderCatManager() {
  const box = $('cat-manage-list');
  if (!box) return;
  if (state.categories.length === 0) {
    box.innerHTML = '<div class="cat-empty">尚無分類，請在上方輸入名稱新增</div>';
    return;
  }
  box.innerHTML = state.categories.map((c, idx) => {
    const n = state.notes.filter(x => x.category === c.id).length;
    return `
    <div class="cat-row" data-id="${esc(c.id)}">
      <input type="text" class="cat-name-input" value="${esc(c.name)}" maxlength="20" aria-label="分類名稱" />
      <span class="cat-count">${n} 則</span>
      <button type="button" class="cat-btn" data-act="up" ${idx === 0 ? 'disabled' : ''} title="上移">↑</button>
      <button type="button" class="cat-btn" data-act="down" ${idx === state.categories.length - 1 ? 'disabled' : ''} title="下移">↓</button>
      <button type="button" class="cat-btn danger" data-act="del" title="刪除">✕</button>
    </div>`;
  }).join('');

  box.querySelectorAll('.cat-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('.cat-name-input').addEventListener('change', (e) => {
      renameCategory(id, e.target.value);
    });
    row.querySelectorAll('.cat-btn').forEach(b => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'up') moveCategory(id, -1);
        else if (act === 'down') moveCategory(id, 1);
        else if (act === 'del') deleteCategory(id);
      };
    });
  });
}

function saveCatsToStorage() {
  writeCats(state.categories);
  renderCategories();
  renderCategorySelect();
  renderNotes();
  cloudSync();
}

function addCategory() {
  const input = $('new-cat-name');
  const name = input.value.trim();
  if (!name) { toast('請輸入分類名稱'); return; }
  if (state.categories.some(c => c.name === name)) { toast('已有同名分類'); return; }
  state.categories.push({ id: 'c_' + uid(), name: name, updatedAt: Date.now() });
  input.value = '';
  renderCatManager();
  saveCatsToStorage();
  toast('已新增分類「' + name + '」');
}

function renameCategory(id, name) {
  const clean = String(name || '').trim();
  const c = state.categories.find(x => x.id === id);
  if (!c) return;
  if (!clean) { toast('名稱不可空白，已還原'); renderCatManager(); return; }
  if (state.categories.some(x => x.id !== id && x.name === clean)) {
    toast('已有同名分類'); renderCatManager(); return;
  }
  c.name = clean;
  c.updatedAt = Date.now();
  saveCatsToStorage();
  toast('已改名為「' + clean + '」');
}

function moveCategory(id, dir) {
  const idx = state.categories.findIndex(x => x.id === id);
  const next = idx + dir;
  if (idx < 0 || next < 0 || next >= state.categories.length) return;
  const tmp = state.categories[idx];
  state.categories[idx] = state.categories[next];
  state.categories[next] = tmp;
  state.categories.forEach(c => { c.updatedAt = Date.now(); });
  renderCatManager();
  saveCatsToStorage();
}

function deleteCategory(id) {
  const c = state.categories.find(x => x.id === id);
  if (!c) return;
  const owned = state.notes.filter(n => n.category === id);
  let dropNotes = false;

  if (owned.length > 0) {
    dropNotes = confirm('分類「' + c.name + '」下有 ' + owned.length + ' 則筆記。\n\n按「確定」＝連筆記一起刪除\n按「取消」＝筆記保留並移到「未分類」');
  } else if (!confirm('確定刪除分類「' + c.name + '」？')) {
    return;
  }

  state.categories = state.categories.filter(x => x.id !== id);
  let notes = readNotes();
  if (dropNotes) {
    notes = notes.filter(n => n.category !== id);
  } else {
    notes = notes.map(n => (n.category === id ? { ...n, category: UNCAT_ID, updatedAt: Date.now() } : n));
  }
  writeNotes(notes);
  state.notes = notes;
  if (state.category === id) state.category = 'all';

  renderCatManager();
  saveCatsToStorage();
  toast('已刪除分類「' + c.name + '」');
}

// ---------- 資料載入（雲端 + 本機合併） ----------
async function loadNotes() {
  const local = readNotes();
  const cloud = await loadFromCloud();
  if (cloud) {
    // 合併雲端和本機（以 id 為準，不重複）
    const merged = (cloud.notes || []).slice();
    const cloudIds = new Set(merged.map(n => n.id));
    for (const n of local) {
      if (!cloudIds.has(n.id)) {
        merged.push(n);
      }
    }
    state.notes = merged;
    writeNotes(state.notes);

    // 合併分類：本機與雲端聯集，同名 id 取較新者
    state.categories = mergeCats(state.categories, cloud.categories);
    writeCats(state.categories);
  } else {
    state.notes = local;
  }
  refreshAll();
}

// ---------- Modal / 新增編輯 ----------
let pendingImage = null;
let pendingPdf = null;

function openModal(note) {
  state.editingId = note ? note.id : null;
  $('modal-title').textContent = note ? '編輯筆記' : '新增筆記';
  $('note-title').value = note ? note.title : '';
  renderCategorySelect();
  if (note) {
    if (hasOption($('note-category'), note.category)) {
      $('note-category').value = note.category;
    } else {
      $('note-category').value = UNCAT_ID;
    }
  } else {
    const preset = (state.category !== 'all' && hasOption($('note-category'), state.category))
      ? state.category
      : (state.categories[0] ? state.categories[0].id : UNCAT_ID);
    $('note-category').value = preset;
  }
  $('note-content').value = note ? note.content : '';

  pendingImage = note?.image || null;
  pendingPdf = note?.pdf || null;

  if (note?.image) {
    $('image-preview').src = note.image;
    $('image-preview-wrap').classList.remove('hidden');
  } else {
    $('image-preview-wrap').classList.add('hidden');
  }
  if (note?.pdf) {
    $('pdf-link').href = note.pdf;
    $('pdf-link').textContent = '📄 開啟 PDF';
    $('pdf-preview-wrap').classList.remove('hidden');
  } else {
    $('pdf-preview-wrap').classList.add('hidden');
  }
  $('note-image').value = '';
  $('note-pdf').value = '';

  $('note-modal').classList.remove('hidden');
  $('note-title').focus();
}

function closeModal() {
  $('note-modal').classList.add('hidden');
  $('note-form').reset();
  $('image-preview-wrap').classList.add('hidden');
  $('pdf-preview-wrap').classList.add('hidden');
  pendingImage = null;
  pendingPdf = null;
  state.editingId = null;
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function saveNote() {
  const title = $('note-title').value.trim();
  const category = $('note-category').value;
  const content = $('note-content').value.trim();
  if (!title) { toast('請輸入標題'); return; }

  const imgInput = $('note-image');
  const pdfInput = $('note-pdf');

  let image = null, pdf = null;
  try {
    if (imgInput.files[0]) {
      // 圖片壓縮（自動 resize + JPEG 壓縮）
      const rawDataUrl = await fileToDataURL(imgInput.files[0]);
      image = await compressImage(rawDataUrl);
    } else if (pendingImage) {
      image = pendingImage;
    }
    if (pdfInput.files[0]) {
      pdf = await fileToDataURL(pdfInput.files[0]);
    } else if (pendingPdf) {
      pdf = pendingPdf;
    }
  } catch (e) {
    toast('檔案處理失敗，已忽略附件');
    image = null; pdf = null;
  }

  const now = Date.now();
  const editing = !!state.editingId;

  saveLocal(title, category, content, image, pdf, now, editing);
  await cloudSync();
  closeModal();
  toast(editing ? '已更新' : '已新增');
}

// 圖片壓縮（最大 1200px, JPEG 0.7）
async function compressImage(dataUrl, maxW = 1200) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxW) { h = h * maxW / w; w = maxW; }
      if (h > maxW * 1.5) { w = w * maxW * 1.5 / h; h = maxW * 1.5; }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// 本機儲存（離線 / fallback）
function saveLocal(title, category, content, image, pdf, now, editing) {
  let notes = readNotes();
  if (editing) {
    notes = notes.map(n => n.id === state.editingId ? {
      ...n, title, category, content,
      image: image ?? n.image, pdf: pdf ?? n.pdf, updatedAt: now
    } : n);
  } else {
    notes.push({ id: uid(), user_id: currentUser?.email || null, title, category, content, image, pdf, createdAt: now, updatedAt: now });
  }
  writeNotes(notes);
  state.notes = notes;
  refreshAll();
}

async function deleteNote(id) {
  if (!confirm('確定刪除此筆記？')) return;
  let notes = readNotes().filter(n => n.id !== id);
  writeNotes(notes);
  state.notes = notes;
  refreshAll();
  await cloudSync();
  toast('已刪除');
}

// 雲端同步：將本機筆記上傳到雲端
async function cloudSync() {
  // 先抓雲端最新資料
  const cloud = await loadFromCloud();
  let notes = readNotes();
  if (cloud) {
    // 合併：雲端有的但本機沒有 = 另一支手機寫的
    const localIds = new Set(notes.map(n => n.id));
    for (const n of (cloud.notes || [])) {
      if (!localIds.has(n.id)) {
        notes.push(n);
      }
    }
    // 分類同步：另一支手機新增/改名的分類
    if (Array.isArray(cloud.categories) && cloud.categories.length) {
      state.categories = mergeCats(state.categories, cloud.categories);
      writeCats(state.categories);
    }
    // 更新本機
    writeNotes(notes);
    state.notes = notes;
    refreshAll();
  }
  const ok = await saveToCloud(notes, state.categories);
  if (ok) { console.log('雲端同步成功'); }
  else { console.warn('雲端同步失敗，資料僅存於本機'); }
}

// 雲端載入：從雲端下載並合併到本機
async function cloudLoad() {
  const remote = await loadFromCloud();
  if (!remote) return;
  const notes = remote.notes || [];
  state.notes = notes;
  writeNotes(notes);
  if (Array.isArray(remote.categories) && remote.categories.length) {
    state.categories = mergeCats(state.categories, remote.categories);
    writeCats(state.categories);
  }
  refreshAll();
}

// ---------- 渲染列表 ----------
function renderNotes() {
  const grid = $('notes-list');
  let list = state.notes.slice();

  if (state.category === UNCAT_ID) {
    list = list.filter(n => !n.category || !state.categories.some(c => c.id === n.category));
  } else if (state.category !== 'all') {
    list = list.filter(n => n.category === state.category);
  }
  if (state.query) {
    list = list.filter(n =>
      (n.title || '').toLowerCase().includes(state.query) ||
      (n.content || '').toLowerCase().includes(state.query)
    );
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (list.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="ico">🗒️</div><div>${state.query ? '找不到符合的筆記' : '尚無筆記，點「+ 新增」開始記錄'}</div></div>`;
    return;
  }

  grid.innerHTML = list.map(n => {
    const img = n.image ? `<img src="${esc(n.image)}" alt="附件圖" loading="lazy" />` : '';
    const pdf = n.pdf ? `<a href="${esc(n.pdf)}" target="_blank" rel="noopener">📄 開啟 PDF</a>` : '';
    const attach = (img || pdf) ? `<div class="note-attachments">${img}${pdf}</div>` : '';
    return `
    <article class="note-card" data-id="${esc(n.id)}">
      <div class="note-meta">
        <span class="note-cat">${esc(catName(n.category))}</span>
        <span>${esc(fmtDate(n.updatedAt || n.createdAt))}</span>
      </div>
      <h3>${esc(n.title)}</h3>
      <div class="note-text">${esc(n.content)}</div>
      ${attach}
      <div class="note-actions">
        <button class="btn-edit" data-edit="${esc(n.id)}">編輯</button>
        <button class="btn-del" data-del="${esc(n.id)}">刪除</button>
      </div>
    </article>`;
  }).join('');

  grid.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const note = state.notes.find(n => n.id === b.dataset.edit);
    if (note) openModal(note);
  });
  grid.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteNote(b.dataset.del));
  grid.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      const n = state.notes.find(x => x.id === card.dataset.id);
      if (n) openModal(n);
    });
  });
}

function updateFab() {
  const fab = $('fab-add');
  if (fab) fab.classList.toggle('show', state.notes.length > 0);
}

// ---------- 啟動 ----------
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(localStorage.getItem(LS_THEME) || 'light');
  initAuth();
});
