/* ===== 多功能筆記本 · 雲端同步版 =====
 * - 已設定 Supabase：auth 登入 + notes 表 CRUD + 即時同步（A 手機改，B 手機秒更新）
 * - 未設定 Supabase：自動退回 localStorage 單機模式
 * - 雲端載入後備份到 localStorage，離線/雲端故障時資料不遺失
 */
'use strict';

// ---------- 設定 / 初始化 ----------
const LS_NOTES = 'notebook:notes';
const LS_THEME = 'notebook:theme';
const LS_USER = 'notebook:user';
const LS_ACCT = 'notebook:accounts'; // 本機帳號（測試用）

// 偵測是否已設定 Supabase
const hasCloudDB = (typeof SUPABASE_URL !== 'undefined')
  && SUPABASE_URL
  && !SUPABASE_URL.includes('your-project')
  && (typeof SUPABASE_ANON_KEY !== 'undefined')
  && SUPABASE_ANON_KEY
  && !SUPABASE_ANON_KEY.includes('your-anon-key');

let cloudRowId = null;

// 分類對照
const CAT_LABELS = { personal: '個人', company: '公司', computer: '電腦', stocks: '股票' };

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
  return data[0].data?.notes || null;
}

async function saveToCloud(notes) {
  if (!hasCloudDB) return false;
  const payload = { data: { key: STORAGE_KEY, notes } };
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
const state = { category: 'personal', query: '', editingId: null, notes: [] };

function initApp() {
  bindAppEvents();
  renderCategories();
  loadNotes();
  updateFab();
}

function bindAppEvents() {
  applyTheme(localStorage.getItem(LS_THEME) || 'light');
  $('theme-toggle').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  };
  document.querySelectorAll('.category-btn').forEach(btn => {
    btn.onclick = () => {
      state.category = btn.dataset.category;
      document.querySelectorAll('.category-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderNotes();
    };
  });

  $('search-input').addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderNotes();
  });

  $('btn-add').onclick = () => openModal(null);
  if ($('fab-add')) $('fab-add').onclick = () => openModal(null);

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

function renderCategories() {
  document.querySelectorAll('.category-btn').forEach(b => {
    const c = b.dataset.category;
    const n = state.notes.filter(x => x.category === c).length;
    b.querySelector('.count')?.remove();
    const span = document.createElement('span');
    span.className = 'count';
    span.textContent = n;
    b.appendChild(span);
  });
}

// ---------- 資料載入（雲端 + 本機合併） ----------
async function loadNotes() {
  const local = readNotes();
  const cloud = await loadFromCloud();
  if (cloud) {
    // 合併雲端和本機（以 id 為準，不重複）
    const merged = cloud.slice();
    const cloudIds = new Set(cloud.map(n => n.id));
    for (const n of local) {
      if (!cloudIds.has(n.id)) {
        merged.push(n);
      }
    }
    state.notes = merged;
    writeNotes(state.notes);
  } else {
    state.notes = local;
  }
  renderNotes();
  renderCategories();
}

// ---------- Modal / 新增編輯 ----------
let pendingImage = null;
let pendingPdf = null;

function openModal(note) {
  state.editingId = note ? note.id : null;
  $('modal-title').textContent = note ? '編輯筆記' : '新增筆記';
  $('note-title').value = note ? note.title : '';
  $('note-category').value = note ? note.category : state.category;
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
  renderNotes();
  renderCategories();
  updateFab();
}

async function deleteNote(id) {
  if (!confirm('確定刪除此筆記？')) return;
  let notes = readNotes().filter(n => n.id !== id);
  writeNotes(notes);
  state.notes = notes;
  renderNotes();
  renderCategories();
  updateFab();
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
    for (const n of cloud) {
      if (!localIds.has(n.id)) {
        notes.push(n);
      }
    }
    // 更新本機
    writeNotes(notes);
    state.notes = notes;
    renderNotes();
    renderCategories();
  }
  const ok = await saveToCloud(notes);
  if (ok) { console.log('雲端同步成功'); }
  else { console.warn('雲端同步失敗，資料僅存於本機'); }
}

// 雲端載入：從雲端下載並合併到本機
async function cloudLoad() {
  const remote = await loadFromCloud();
  if (!remote) return;
  state.notes = remote;
  writeNotes(remote);
  renderNotes();
  renderCategories();
}

// ---------- 渲染列表 ----------
function renderNotes() {
  const grid = $('notes-list');
  let list = state.notes.slice();

  if (state.category !== 'all') list = list.filter(n => n.category === state.category);
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
        <span class="note-cat">${esc(CAT_LABELS[n.category] || n.category)}</span>
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
