-- CLIVA予約システム DBスキーマ（Supabase / PostgreSQL想定）
-- Supabaseの「SQL Editor」にそのまま貼り付けて実行できます。

-- 患者情報（LINEユーザーIDと紐づけ）
create table patients (
  id            bigserial primary key,
  line_user_id  text unique not null,
  name          text,
  phone         text,
  created_at    timestamptz not null default now()
);

-- 予約
create table reservations (
  id            bigserial primary key,
  patient_id    bigint references patients(id) on delete cascade,
  department    text not null,               -- 診療科（歯科・内科・皮膚科・小児科・整形外科・心療内科 等）
  scheduled_at  timestamptz not null,         -- 予約日時
  symptom       text,                         -- 症状・相談内容（主訴）
  status        text not null default 'before' -- before(来院前) / checked_in(受付済) / cancelled(キャンセル)
                check (status in ('before', 'checked_in', 'cancelled')),
  memo          text,                         -- 電話対応メモ等、スタッフ用の備考
  reservation_no text unique,                 -- 患者に提示する予約番号（例: A-1024）
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- LINE会話の一時状態（予約フロー進行中のセッション情報）
create table user_sessions (
  line_user_id  text primary key,
  state         text not null default 'DEPT'  -- DEPT / DATETIME / INFO_NAME / INFO_PHONE / INFO_SYMPTOM / DONE
                check (state in ('DEPT', 'DATETIME', 'INFO_NAME', 'INFO_PHONE', 'INFO_SYMPTOM', 'DONE')),
  temp_department text,
  temp_datetime   timestamptz,
  temp_name       text,
  temp_phone      text,
  temp_symptom    text,
  updated_at      timestamptz not null default now()
);

-- 予約枠（あらかじめクリニック側が空き枠を登録しておく場合に使用。MVPでは省略可）
create table available_slots (
  id            bigserial primary key,
  department    text not null,
  slot_at       timestamptz not null,
  capacity      int not null default 1,
  booked_count  int not null default 0,
  unique (department, slot_at)
);

-- 予約番号を自動採番する簡易関数（例: A-1024のような形式）
create sequence reservation_no_seq start 1000;

create or replace function next_reservation_no()
returns text as $$
  select 'A-' || nextval('reservation_no_seq')::text;
$$ language sql;

