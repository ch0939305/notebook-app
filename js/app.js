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

// 偵測是否已設定真實 Supabase（仍是預設佔位字串則視為未設定）
const hasSupabase = (typeof SUPABASE_URL !== 'undefined')
  && SUPABASE_URL
  && !SUPABASE_URL.includes('your-project')
  && (typeof SUPABASE_ANON_KEY !== 'undefined')
  && SUPABASE_ANON_KEY
  && !SUPABASE_ANON_KEY.includes('your-anon-key');

let supa = null;
if (hasSupabase && window.supabase) {
  try {
    supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  } catch (e) {
    console.warn('Supabase 初始化失敗，改用本機模式：', e.message);
  }
}
const useLocal = !supa;

// 分類對照
const CAT_LABELS = { personal: '個人', company: '公司', computer: '電腦', stocks: '股票' };

// 目前使用者（雲端模式含 id；本機模式只有 email）
let currentUser = null;
let realtimeChannel = null;

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

// 雲端列 ↔ 本機物件轉換
const mapFromRow = (r) => ({
  id: r.id,
  user_id: r.user_id,
  title: r.title || '',
  category: r.category || 'personal',
  content: r.content || '',
  image: r.image || null,
  pdf: r.pdf || null,
  createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
  updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : Date.now()
});
const mapToRow = (n) => ({
  id: n.id,
  user_id: currentUser?.id || null,
  title: n.title,
  category: n.category,
  content: n.content,
  image: n.image,
  pdf: n.pdf,
  created_at: new Date(n.createdAt).toISOString(),
  updated_at: new Date(n.updatedAt).toISOString()
});

// ---------- 主題 ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(LS_THEME, theme);
  const tg = $('theme-toggle');
  if (tg) tg.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ---------- 登入 / 註冊 ----------
function initAuth() {
  // 雲端模式：監聽 auth 狀態，已登入直接進應用
  if (supa) {
    supa.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        currentUser = { id: session.user.id, email: session.user.email };
        localStorage.setItem(LS_USER, session.user.email);
        enterApp();
      } else {
        currentUser = null;
        localStorage.removeItem(LS_USER);
        $('app-screen')?.classList.add('hidden');
        $('auth-screen')?.classList.remove('hidden');
      }
    });
    // 嘗試還原 session
    supa.auth.getSession().then(({ data }) => {
      if (data.session?.user) {
        currentUser = { id: data.session.user.id, email: data.session.user.email };
        localStorage.setItem(LS_USER, data.session.user.email);
        enterApp();
      }
    });
  } else {
    // 本機模式：已登入則直接進
    const u = localStorage.getItem(LS_USER);
    if (u) { currentUser = { email: u }; enterApp(); }
  }

  const form = $('auth-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
  $('btn-signup').addEventListener('click', doSignup);
}

async function doLogin() {
  const email = $('auth-email').value.trim();
  const pw = $('auth-password').value.trim();
  if (!email || pw.length < 6) { toast('請輸入 Email 與至少 6 碼密碼'); return; }

  if (supa) {
    const { data, error } = await supa.auth.signInWithPassword({ email, password: pw });
    if (error) { toast('登入失敗：' + error.message); return; }
    // onAuthStateChange 會自動 enterApp
    return;
  }

  // 本機模式
  const accts = JSON.parse(localStorage.getItem(LS_ACCT) || '{}');
  if (Object.keys(accts).length === 0) {
    accts[email] = pw;
    localStorage.setItem(LS_ACCT, JSON.stringify(accts));
  } else if (accts[email] !== pw) {
    toast('帳號或密碼錯誤'); return;
  }
  currentUser = { email };
  localStorage.setItem(LS_USER, email);
  enterApp();
}

async function doSignup() {
  const email = $('auth-email').value.trim();
  const pw = $('auth-password').value.trim();
  if (!email || pw.length < 6) { toast('請輸入 Email 與至少 6 碼密碼'); return; }

  if (supa) {
    const { data, error } = await supa.auth.signUp({ email, password: pw });
    if (error) { toast('註冊失敗：' + error.message); return; }
    if (data?.user && !data.session) {
      toast('註冊成功，請至信箱確認後登入');
    }
    return;
  }

  const accts = JSON.parse(localStorage.getItem(LS_ACCT) || '{}');
  if (accts[email]) { toast('此 Email 已註冊，請直接登入'); return; }
  accts[email] = pw;
  localStorage.setItem(LS_ACCT, JSON.stringify(accts));
  currentUser = { email };
  localStorage.setItem(LS_USER, email);
  toast('註冊成功，已自動登入');
  enterApp();
}

function enterApp() {
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  initApp();
}

async function doLogout() {
  if (realtimeChannel) { try { supa.removeChannel(realtimeChannel); } catch {} realtimeChannel = null; }
  if (supa) { await supa.auth.signOut(); }
  localStorage.removeItem(LS_USER);
  currentUser = null;
  $('app-screen').classList.add('hidden');
  $('auth-screen').classList.remove('hidden');
  $('auth-form').reset();
}

// ---------- 主應用 ----------
const state = { category: 'personal', query: '', editingId: null, notes: [] };

function initApp() {
  bindAppEvents();
  renderCategories();
  loadNotes(); // 雲端或本機載入
  updateFab();
}

function bindAppEvents() {
  applyTheme(localStorage.getItem(LS_THEME) || 'light');
  $('theme-toggle').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  };
  $('btn-logout').onclick = doLogout;

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

  $('note-image').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      $('image-preview').src = ev.target.result;
      $('image-preview-wrap').classList.remove('hidden');
    };
    reader.readAsDataURL(f);
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

// ---------- 資料載入（雲端 / 本機） ----------
async function loadNotes() {
  if (supa && currentUser?.id) {
    try {
      const { data, error } = await supa
        .from('notes')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      state.notes = (data || []).map(mapFromRow);
      // 雲端備份到本機（離線/防遺失）
      writeNotes(state.notes);
      renderNotes();
      renderCategories();
      subscribeRealtime();
    } catch (e) {
      console.warn('雲端載入失敗，改用本機備份：', e.message);
      toast('雲端載入失敗，已切換本機資料');
      state.notes = readNotes();
      renderNotes();
      renderCategories();
    }
  } else {
    state.notes = readNotes();
    renderNotes();
    renderCategories();
  }
}

// 即時同步：A 手機變更，B 手機秒級更新
function subscribeRealtime() {
  if (!supa || !currentUser?.id || realtimeChannel) return;
  try {
    realtimeChannel = supa
      .channel('notes-realtime')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'notes', filter: `user_id=eq.${currentUser.id}` },
        () => { loadNotes(); } // 任一變更即重新載入（含對方手機的修改）
      )
      .subscribe();
  } catch (e) {
    console.warn('即時同步訂閱失敗：', e.message);
  }
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
  const imgP = imgInput.files[0] ? fileToDataURL(imgInput.files[0]) : Promise.resolve(pendingImage);
  const pdfP = pdfInput.files[0] ? fileToDataURL(pdfInput.files[0]) : Promise.resolve(pendingPdf);

  let image, pdf;
  try { [image, pdf] = await Promise.all([imgP, pdfP]); }
  catch { toast('檔案處理失敗，已忽略附件'); image = null; pdf = null; }

  const now = Date.now();
  const editing = !!state.editingId;

  if (supa && currentUser?.id) {
    // 雲端儲存
    try {
      if (editing) {
        const row = {
          title, category, content,
          image: image ?? undefined,
          pdf: pdf ?? undefined,
          updated_at: new Date(now).toISOString()
        };
        const { error } = await supa.from('notes').update(row).eq('id', state.editingId).eq('user_id', currentUser.id);
        if (error) throw error;
      } else {
        const id = uid();
        const row = {
          id, user_id: currentUser.id, title, category, content,
          image: image || null, pdf: pdf || null,
          created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString()
        };
        const { error } = await supa.from('notes').insert(row);
        if (error) throw error;
      }
      closeModal();
      toast(editing ? '已更新（已同步）' : '已新增（已同步）');
      // realtime 會自動 reload；保險起見也手動 reload
      await loadNotes();
      updateFab();
    } catch (e) {
      console.warn('雲端儲存失敗，改存本機：', e.message);
      toast('雲端儲存失敗，已存本機（待連線自動同步）');
      saveLocal(title, category, content, image, pdf, now, editing);
    }
  } else {
    saveLocal(title, category, content, image, pdf, now, editing);
    closeModal();
    toast(editing ? '已更新' : '已新增');
  }
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

  if (supa && currentUser?.id) {
    try {
      const { error } = await supa.from('notes').delete().eq('id', id).eq('user_id', currentUser.id);
      if (error) throw error;
      toast('已刪除（已同步）');
      await loadNotes();
      updateFab();
    } catch (e) {
      console.warn('雲端刪除失敗：', e.message);
      toast('雲端刪除失敗');
    }
  } else {
    let notes = readNotes().filter(n => n.id !== id);
    writeNotes(notes);
    state.notes = notes;
    renderNotes();
    renderCategories();
    updateFab();
    toast('已刪除');
  }
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
