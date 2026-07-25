-- ============================================================
-- 多功能筆記本 · Supabase 一鍵設定
-- 在 Supabase Dashboard → SQL Editor 貼上整段執行即可
-- ============================================================

-- 1. 建立 notes 表
create table if not exists public.notes (
  id          text primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  title       text,
  category    text default 'personal',
  content     text,
  image       text,          -- base64（個人筆記夠用；大檔日後可改 storage）
  pdf         text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- 2. 啟用列層級安全（RLS）：用戶只能存取自己的筆記
alter table public.notes enable row level security;

-- 3. RLS 政策：同一使用者 A/B 手機登入同帳號即可共享資料
drop policy if exists "notes_select_own" on public.notes;
create policy "notes_select_own"
  on public.notes for select
  using (auth.uid() = user_id);

drop policy if exists "notes_insert_own" on public.notes;
create policy "notes_insert_own"
  on public.notes for insert
  with check (auth.uid() = user_id);

drop policy if exists "notes_update_own" on public.notes;
create policy "notes_update_own"
  on public.notes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_delete_own"
  on public.notes for delete
  using (auth.uid() = user_id);

-- 4. updated_at 自動更新觸發器
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists notes_touch on public.notes;
create trigger notes_touch
  before update on public.notes
  for each row execute function public.touch_updated_at();

-- 5. 開啟即時同步（A 改 B 秒更新）
do $$
begin
  begin
    alter publication supabase_realtime add table public.notes;
  exception when others then
    null; -- 已存在則忽略
  end;
end $$;

-- ============================================================
-- 設定完成！接著：
-- 1. Authentication → Providers → Email 開啟（允許帳號註冊）
-- 2. 複製 Settings → API 的 Project URL 與 anon public key
-- 3. 填入 js/config.js 的 SUPABASE_URL 與 SUPABASE_ANON_KEY
-- ============================================================
