// CLIVA予約システム Webhookサーバー
// 患者からのLINEメッセージを受け取り、日時選択(カード型)→氏名/電話/症状入力→予約確定
// の順に会話を進め、Supabase(PostgreSQL)に保存します。
//
// 診療科の選択ステップは廃止しました。予約データ上は department を空欄のまま保存し、
// 受診科はスタッフが後から電話・問診等で確認して入力する運用を前提としています。
//
// ---- マルチクリニックSaaS化 Phase 3（2026-07-10）----
// 従来は起動時に1つの LINEクライアント（config/client）だけをグローバルに生成していましたが、
// 医院ごとに異なる LINEチャネル・診療枠設定（診療時間・枠の刻み・同時受付上限）に対応するため、
// リクエスト（Webhook呼び出し）ごとに「どの医院宛てか」を解決し、その医院用の情報をまとめた
// ctx オブジェクト（clinicContext.js参照）を各処理関数に引き回す構成に変更しています。
// 変更点の詳細は CLIVA_SAAS化_実装ロードマップ.md の Phase 3、
// および CLIVA_SaaS_Phase3_deploy_guide.md を参照してください。
// 2026-07-10 本番デプロイ・LINE上での動作確認済み。
//
// ---- マルチクリニックSaaS化 Phase 5（2026-07-10）----
// 運営者（あなた）用ダッシュボードを追加。/platform-admin で全医院の一覧・稼働状況の確認、
// 新規医院登録（webhook_path自動発行・LINE認証情報の暗号化保存）ができるようにしています。
// 権限確認は platform_admins テーブルで行い、clinic_admins（各医院のスタッフ）とは
// 別の権限として扱っています。詳細は platformAdmin.js を参照してください。
//
// ---- 運営者専用リンク集（2026-07-10）----
// /links で、Supabase/Render/GitHub/Netlifyのログインページと、運営者ダッシュボード・
// 予約管理画面へのリンクをまとめた自分専用ページを追加。Supabase Authでログインし、
// さらにplatform_adminsに登録された本人であることを /api/platform/me で確認できた場合のみ
// 中身を表示する（platformAdmin.jsのrequirePlatformAdminミドルウェアを流用）。

require('dotenv').config();
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const { createCalendarEvent, updateCalendarEvent, markCalendarEventCancelled } = require('./googleCalendar');
const { createAdminRouter } = require('./admin');
const { fetchClinicRow, buildClinicContext } = require('./clinicContext');
const { createPlatformAdminRouter } = require('./platformAdmin');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();

// ---- 落ち着いたセージグリーン系のカラートークン（LPと統一） ----
const COLORS = {
  pageBg: '#F4F7F4',
  cardBg: '#FFFFFF',
  cardBorder: '#A9C4B2',
  titleText: '#33473C',
  subText: '#6B7C71',
  accentText: '#3F6B52',
};

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

// ---- タイムゾーン関連ヘルパー ----
// 本番(Render等)のサーバーはUTCで動作するため、サーバーのローカル時刻(new Date()の
// getHours/getDate等)をそのままJSTとして扱うと9時間ズレる。
// 以下のヘルパーは、サーバーのタイムゾーンに関係なく常にAsia/Tokyo基準で計算する。
const JST_OFFSET_MINUTES = 9 * 60;

// 「現在時刻をJSTの壁時計として見た年月日」を取得するためのDateオブジェクトを作る。
// （このDateの getUTC* 系メソッドで読むと、JSTの年月日時分がそのまま得られる）
function nowAsJstWallClock() {
  const now = new Date();
  return new Date(now.getTime() + JST_OFFSET_MINUTES * 60 * 1000);
}

// JSTの年月日時分を指定して、正しいUTC ISO文字列（Googleカレンダー等に渡す実時刻）を作る
function jstToIsoString(year, month, day, hour = 0, minute = 0) {
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMs).toISOString();
}

// ---- 日付候補（今日から7日分、JST基準） ----
function buildDateOptions() {
  const dayLabels = ['今日', '明日', '明後日'];
  const offsets = [0, 1, 2, 3, 4, 5, 6];
  const jstNow = nowAsJstWallClock();
  return offsets.map((offset) => {
    const d = new Date(jstNow.getTime());
    d.setUTCDate(d.getUTCDate() + offset);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const weekday = d.getUTCDay();
    const prefix = dayLabels[offset] ? `${dayLabels[offset]}　` : '';
    const label = `${prefix}${m}/${day}(${WEEKDAY_JA[weekday]})`;
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { label, iso }; // iso は YYYY-MM-DD（JSTでの日付）
  });
}

// JSTの日付(YYYY-MM-DD)から、その日の開始〜翌日開始までのUTC ISO範囲を作る
// （Supabaseへの「その日の予約を全部取得する」クエリで使う）
function jstDayRangeIso(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const startIso = jstToIsoString(y, m, d, 0, 0);
  // 翌日の年月日を Date.UTC の自動繰り上げで求める（月末・年末をまたいでも安全）
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
  const endIso = jstToIsoString(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0);
  return { startIso, endIso };
}

// 指定日の「枠ごとの予約件数」を取得する（キャンセル済みは除外）
// 取得に失敗した場合は空オブジェクトを返す＝満枠判定をせず通常表示にする（安全側に倒す）
// ctx.clinicId で自院のデータだけに絞り込む
async function getBookedCountsForDate(ctx, dateIso) {
  const { startIso, endIso } = jstDayRangeIso(dateIso);
  const { data, error } = await supabase
    .from('reservations')
    .select('scheduled_at')
    .eq('clinic_id', ctx.clinicId)
    .gte('scheduled_at', startIso)
    .lt('scheduled_at', endIso)
    .neq('status', 'cancelled');

  if (error) {
    console.error(`[slots] 予約件数の取得に失敗しました: ${error.message}`);
    return {};
  }

  const counts = {};
  (data || []).forEach((row) => {
    const iso = new Date(row.scheduled_at).toISOString();
    counts[iso] = (counts[iso] || 0) + 1;
  });
  return counts;
}

// 指定した日時（ISO文字列）が、すでに上限件数に達しているかを調べる
// 上限件数は ctx.clinicConfig.maxReservationsPerSlot（医院ごとの設定）を使う
async function isSlotFull(ctx, datetimeIso) {
  const d = new Date(datetimeIso);
  const jstMs = d.getTime() + JST_OFFSET_MINUTES * 60 * 1000;
  const jstDate = new Date(jstMs);
  const dateIso = `${jstDate.getUTCFullYear()}-${String(jstDate.getUTCMonth() + 1).padStart(2, '0')}-${String(
    jstDate.getUTCDate()
  ).padStart(2, '0')}`;
  const counts = await getBookedCountsForDate(ctx, dateIso);
  const normalizedIso = new Date(datetimeIso).toISOString();
  return (counts[normalizedIso] || 0) >= ctx.clinicConfig.maxReservationsPerSlot;
}

// ---- 指定日付に対する時間候補（JST基準・満枠判定つき） ----
// 時間候補一覧は ctx.clinicConfig.timeSlots（医院ごとの診療時間・枠の刻みから生成済み）を使う
async function buildTimeOptionsForDate(ctx, dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const counts = await getBookedCountsForDate(ctx, dateIso);
  return ctx.clinicConfig.timeSlots.map((t) => {
    const [h, min] = t.split(':').map(Number);
    const iso = jstToIsoString(y, m, d, h, min);
    const bookedCount = counts[iso] || 0;
    const full = bookedCount >= ctx.clinicConfig.maxReservationsPerSlot;
    return { label: t, iso, full };
  });
}

// ---- Flex Message: カード型の選択肢を1枚のバブルにまとめる ----
// options: [{ label, data, displayText, disabled }]
// disabled: true の場合はタップ不可のグレーアウト表示にする（満枠表示などに使用）
function buildCardSelectFlex({ altText, heading, subheading, options, footerOptions = [] }) {
  const optionBox = (opt, accentBorder = false) => {
    const disabled = !!opt.disabled;
    return {
      type: 'box',
      layout: 'vertical',
      cornerRadius: '12px',
      borderWidth: accentBorder ? '2px' : '1px',
      borderColor: disabled ? '#D9DDD9' : COLORS.cardBorder,
      backgroundColor: disabled ? '#EDEEEC' : COLORS.cardBg,
      paddingAll: '18px',
      margin: 'md',
      // 満枠の場合はaction自体を付けない＝タップしても何も起きない
      ...(disabled
        ? {}
        : {
            action: {
              type: 'postback',
              data: opt.data,
              displayText: opt.displayText || opt.label,
            },
          }),
      contents: [
        {
          type: 'text',
          text: opt.label,
          size: 'xl',
          weight: 'bold',
          align: 'center',
          wrap: true,
          color: disabled ? '#A6ACA6' : COLORS.titleText,
        },
      ],
    };
  };

  const contents = [
    {
      type: 'text',
      text: heading,
      size: 'lg',
      weight: 'bold',
      color: COLORS.titleText,
      wrap: true,
    },
  ];

  if (subheading) {
    contents.push({
      type: 'text',
      text: subheading,
      size: 'sm',
      color: COLORS.subText,
      margin: 'xs',
      wrap: true,
    });
  }

  options.forEach((opt) => contents.push(optionBox(opt)));

  if (footerOptions.length > 0) {
    contents.push({
      type: 'separator',
      margin: 'lg',
    });
    footerOptions.forEach((opt) => contents.push(optionBox(opt)));
  }

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: COLORS.pageBg,
        paddingAll: '20px',
        contents,
      },
    },
  };
}

// ---- 日付選択カードを送信 ----
function sendDateCards(ctx, replyToken) {
  const dateOptions = buildDateOptions();
  const flex = buildCardSelectFlex({
    altText: 'ご希望の日付を選んでください',
    heading: 'ご希望の日付を選んでください',
    subheading: 'カードをタップすると次に進みます',
    options: dateOptions.map((d) => ({
      label: d.label,
      data: `action=selectDate&value=${d.iso}`,
      displayText: d.label,
    })),
  });
  return ctx.client.replyMessage(replyToken, flex);
}

// ---- 時間選択カードを送信（「日付選びなおし」の戻るカード付き、満枠は表示のみでタップ不可） ----
async function sendTimeCards(ctx, replyToken, dateIso, dateLabel) {
  const timeOptions = await buildTimeOptionsForDate(ctx, dateIso);
  const flex = buildCardSelectFlex({
    altText: 'ご希望の時間を選んでください',
    heading: 'ご希望の時間を選んでください',
    subheading: `${dateLabel} のご希望時間`,
    options: timeOptions.map((t) => ({
      label: t.full ? `${t.label}（満枠）` : t.label,
      data: `action=selectTime&value=${t.iso}`,
      displayText: t.full ? `${t.label}（満枠）` : t.label,
      disabled: t.full,
    })),
    footerOptions: [
      {
        label: '← 日付を選びなおす',
        data: 'action=backToDate',
        displayText: '日付を選びなおす',
      },
    ],
  });
  return ctx.client.replyMessage(replyToken, flex);
}

// ---- セッション取得・更新 ----
// user_sessions はまだ (clinic_id, line_user_id) の複合一意制約になっていないため
// （一意制約の見直しはPhase 3のコード安定後に実施予定）、
// 現時点では clinic_id を条件・保存値として追加するに留めている
async function getSession(ctx, lineUserId) {
  const { data } = await supabase
    .from('user_sessions')
    .select('*')
    .eq('clinic_id', ctx.clinicId)
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (data) return data;

  const { data: created } = await supabase
    .from('user_sessions')
    .insert({ clinic_id: ctx.clinicId, line_user_id: lineUserId, state: 'DATE' })
    .select()
    .single();
  return created;
}

async function updateSession(ctx, lineUserId, patch) {
  await supabase
    .from('user_sessions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('clinic_id', ctx.clinicId)
    .eq('line_user_id', lineUserId);
}

async function resetSession(ctx, lineUserId) {
  await supabase
    .from('user_sessions')
    .update({
      state: 'DATE',
      temp_date: null,
      temp_datetime: null,
      temp_name: null,
      temp_phone: null,
      temp_symptom: null,
      mode: 'new',
      target_reservation_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('clinic_id', ctx.clinicId)
    .eq('line_user_id', lineUserId);
}

// ---- 予約確定処理 ----
// department は空欄（null）で保存し、受診科はスタッフが後から確認・入力する。
async function finalizeReservation(ctx, lineUserId, session) {
  let { data: patient } = await supabase
    .from('patients')
    .select('*')
    .eq('clinic_id', ctx.clinicId)
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (!patient) {
    const { data: created } = await supabase
      .from('patients')
      .insert({
        clinic_id: ctx.clinicId,
        line_user_id: lineUserId,
        name: session.temp_name,
        phone: session.temp_phone,
      })
      .select()
      .single();
    patient = created;
  } else {
    await supabase
      .from('patients')
      .update({ name: session.temp_name, phone: session.temp_phone })
      .eq('id', patient.id);
  }

  const { data: reservationNo, error: noError } = await supabase.rpc('next_reservation_no');
  const finalReservationNo = noError || !reservationNo ? `A-${Math.floor(1000 + Math.random() * 9000)}` : reservationNo;

  const { data: reservation } = await supabase
    .from('reservations')
    .insert({
      clinic_id: ctx.clinicId,
      patient_id: patient.id,
      department: null, // 受診科は未確定。スタッフが後から確認・入力する
      scheduled_at: session.temp_datetime,
      symptom: session.temp_symptom,
      status: 'reserved',
      source: 'line', // LINE予約経由は自動でsource=lineとして保存する
      reservation_no: finalReservationNo,
      // この予約をした時点の氏名・電話番号をスナップショットとして保存する。
      // patients.name/phone は同じLINEアカウントの次回予約で上書きされるため、
      // 過去の予約の表示名がそれに引っ張られて変わってしまわないようにするため。
      patient_name: session.temp_name,
      patient_phone: session.temp_phone,
    })
    .select()
    .single();

  // Google カレンダーへ予定を自動作成する。
  // ここでの失敗は予約完了を妨げない（失敗しても予約は確定させ、ログだけ残す）。
  // 認証情報が未設定の場合は googleCalendar 側でスキップされる。
  // 注意：Googleカレンダー連携はまだ医院ごとに分離していない（Phase 6で対応予定）。
  try {
    const calendarResult = await createCalendarEvent({
      name: session.temp_name,
      phone: session.temp_phone,
      symptom: session.temp_symptom,
      scheduledAt: reservation.scheduled_at,
      lineUserId,
    });
    if (!calendarResult.ok && !calendarResult.skipped) {
      console.error(
        `[calendar] 予約 ${reservation.reservation_no} のカレンダー登録に失敗しました: ${calendarResult.error}`
      );
    }
    // 作成できた場合は、後からキャンセル・変更時にこの予定を操作できるよう eventId を保存しておく
    if (calendarResult.ok && calendarResult.eventId) {
      await supabase
        .from('reservations')
        .update({ calendar_event_id: calendarResult.eventId })
        .eq('id', reservation.id);
    }
  } catch (calendarErr) {
    // createCalendarEvent 内で握りつぶしているが、念のため二重に保護する
    console.error(
      `[calendar] 予約 ${reservation.reservation_no} のカレンダー登録で予期しないエラー:`,
      calendarErr
    );
  }

  await resetSession(ctx, lineUserId);
  return reservation;
}

// ---- 予約変更・キャンセル機能 ----

// LINEユーザーの直近の有効な予約（来院前・現在時刻より後）を「すべて」取得する。
// 複数件の予約を持つ患者でも、どの予約を変更・キャンセルしたいか選べるようにするため、
// 以前のように .limit(1) で1件だけに絞らない。
async function findUpcomingReservations(ctx, lineUserId) {
  const { data: patient } = await supabase
    .from('patients')
    .select('id')
    .eq('clinic_id', ctx.clinicId)
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (!patient) return [];

  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from('reservations')
    .select('*')
    .eq('clinic_id', ctx.clinicId)
    .eq('patient_id', patient.id)
    .eq('status', 'reserved')
    .gte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true });
  return data || [];
}

// 指定した1件の予約について「日時を変更する／キャンセルする」の選択メニューを組み立てる
function buildChangeCancelOptionsFlex(reservation) {
  return buildCardSelectFlex({
    altText: 'ご予約の変更・キャンセル',
    heading: 'ご予約の変更・キャンセル',
    subheading: `対象のご予約：${formatDatetime(reservation.scheduled_at)}`,
    options: [
      {
        label: '日時を変更する',
        data: `action=cxlMenu&value=change&rid=${reservation.id}`,
        displayText: '日時を変更する',
      },
      {
        label: 'キャンセルする',
        data: `action=cxlMenu&value=cancel&rid=${reservation.id}`,
        displayText: 'キャンセルする',
      },
    ],
  });
}

// 「変更」「キャンセル」キーワードへの入口。
// 有効な予約が2件以上ある場合は、まずどの予約を対象にするか選んでもらう。
async function handleChangeCancelMenu(ctx, event, lineUserId) {
  const reservations = await findUpcomingReservations(ctx, lineUserId);

  if (reservations.length === 0) {
    return ctx.client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        '現在お受けしている有効なご予約が見つかりませんでした。\n' +
        '新しく予約されたい場合は「予約」とお送りください。',
    });
  }

  if (reservations.length === 1) {
    return ctx.client.replyMessage(event.replyToken, buildChangeCancelOptionsFlex(reservations[0]));
  }

  // 予約が複数ある場合は、まず対象を選んでもらう
  const flex = buildCardSelectFlex({
    altText: 'どちらのご予約を変更・キャンセルしますか',
    heading: 'どちらのご予約について変更・キャンセルしますか？',
    subheading: '対象のご予約を選んでください',
    options: reservations.map((r) => ({
      label: `${formatDatetime(r.scheduled_at)}\n（予約番号 ${r.reservation_no}）`,
      data: `action=selectReservation&rid=${r.id}`,
      displayText: `${formatDatetime(r.scheduled_at)}の予約`,
    })),
  });
  return ctx.client.replyMessage(event.replyToken, flex);
}

// 日時変更フローの最終処理：予約の日時を更新し、Googleカレンダーの予定も追随して更新する
async function finalizeReschedule(ctx, event, lineUserId, session, newDatetimeIso) {
  const targetId = session.target_reservation_id;

  const { data: reservation } = await supabase
    .from('reservations')
    .select('*')
    .eq('clinic_id', ctx.clinicId)
    .eq('id', targetId)
    .maybeSingle();

  if (!reservation || reservation.status !== 'reserved') {
    await resetSession(ctx, lineUserId);
    return ctx.client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        'このご予約はすでに変更・キャンセル済み、または見つかりませんでした。\n' +
        'お手数ですが「予約」とお送りして新規にご予約ください。',
    });
  }

  const { data: updated } = await supabase
    .from('reservations')
    .update({ scheduled_at: newDatetimeIso })
    .eq('id', targetId)
    .select()
    .single();

  // Googleカレンダーの予定も追随して更新する（失敗しても予約変更自体は完了させる）
  if (updated.calendar_event_id) {
    const { data: patient } = await supabase
      .from('patients')
      .select('*')
      .eq('id', updated.patient_id)
      .maybeSingle();

    const result = await updateCalendarEvent({
      eventId: updated.calendar_event_id,
      name: patient ? patient.name : undefined,
      phone: patient ? patient.phone : undefined,
      symptom: updated.symptom,
      scheduledAt: newDatetimeIso,
      lineUserId,
    });
    if (!result.ok && !result.skipped) {
      console.error(`[calendar] 予約 ${updated.reservation_no} の変更反映に失敗しました: ${result.error}`);
    }
  }

  await resetSession(ctx, lineUserId);

  return ctx.client.replyMessage(event.replyToken, {
    type: 'text',
    text:
      `ご予約を変更しました。\n${formatDatetime(updated.scheduled_at)}\n予約番号　${updated.reservation_no}\n\n` +
      `※さらに変更・キャンセルをされる場合は、\n` +
      `「変更」または「キャンセル」と送信してください。`,
  });
}

// ---- テキストメッセージのハンドラ（氏名・電話・症状入力ステップ） ----
async function handleTextMessage(ctx, event) {
  const lineUserId = event.source.userId;
  const text = event.message.text.trim();
  const session = await getSession(ctx, lineUserId);

  // 「変更」「キャンセル」というキーワードには、会話の途中状態に関わらず反応する
  if (text.includes('変更') || text.includes('キャンセル')) {
    return handleChangeCancelMenu(ctx, event, lineUserId);
  }

  // 「予約」等のキーワードでいつでもリセットして最初から
  if (text.includes('予約') && session.state !== 'DATE') {
    await resetSession(ctx, lineUserId);
    return sendDateCards(ctx, event.replyToken);
  }

  switch (session.state) {
    case 'DATE':
    case 'TIME':
      // 日時選択中はカードのタップ（postback）を待つ。テキストが来たら案内し直す。
      return sendDateCards(ctx, event.replyToken);

    case 'INFO_NAME': {
      await updateSession(ctx, lineUserId, { temp_name: text, state: 'INFO_PHONE' });
      return ctx.client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'お名前を確認しました。\nお電話番号を教えてください（例：090-1234-5678）',
      });
    }

    case 'INFO_PHONE': {
      await updateSession(ctx, lineUserId, { temp_phone: text, state: 'INFO_SYMPTOM' });
      return ctx.client.replyMessage(event.replyToken, {
        type: 'text',
        text: '症状やご相談内容を教えてください',
      });
    }

    case 'INFO_SYMPTOM': {
      const updatedSession = { ...session, temp_symptom: text };
      await updateSession(ctx, lineUserId, { temp_symptom: text, state: 'DONE' });
      const reservation = await finalizeReservation(ctx, lineUserId, updatedSession);
      const messages = [
        {
          type: 'text',
          text:
            `ご予約を受け付けました。\n` +
            `${formatDatetime(reservation.scheduled_at)}\n` +
            `予約番号　${reservation.reservation_no}\n\n` +
            `受診科につきましては、追ってスタッフよりご連絡いたします。\n` +
            `当日はお気をつけてお越しください。\n\n` +
            `※ご予約の変更またはキャンセルをされる場合は、\n` +
            `「変更」または「キャンセル」と送信してください。`,
        },
      ];

      // 問診フォームのURLを案内する（BASE_URLが設定されている場合のみ）
      const questionnaireUrl = buildQuestionnaireUrl(reservation.id);
      if (questionnaireUrl) {
        messages.push({
          type: 'text',
          text:
            `来院前に、以下の問診フォームのご入力をお願いいたします。\n\n` +
            `${questionnaireUrl}\n\n` +
            `入力は1〜2分ほどで完了します。`,
        });
      }

      return ctx.client.replyMessage(event.replyToken, messages);
    }

    default: {
      await resetSession(ctx, lineUserId);
      return sendDateCards(ctx, event.replyToken);
    }
  }
}

// ---- ポストバックのハンドラ（日付・時間カードのタップ） ----
async function handlePostback(ctx, event) {
  const lineUserId = event.source.userId;
  const session = await getSession(ctx, lineUserId);
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');

  if (action === 'selectDate') {
    const dateIso = params.get('value');
    const dateOptions = buildDateOptions();
    const matched = dateOptions.find((d) => d.iso === dateIso);
    const dateLabel = matched ? matched.label : dateIso;
    await updateSession(ctx, lineUserId, { temp_date: dateIso, state: 'TIME' });
    return sendTimeCards(ctx, event.replyToken, dateIso, dateLabel);
  }

  if (action === 'selectTime') {
    const datetimeIso = params.get('value');

    // タップした瞬間と実際の処理の間にわずかな時間差があるため、
    // 他の患者がほぼ同時に予約して枠が埋まった場合に備えて再チェックする
    const full = await isSlotFull(ctx, datetimeIso);
    if (full) {
      const dateIso = session.temp_date;
      const dateOptions = buildDateOptions();
      const matched = dateOptions.find((d) => d.iso === dateIso);
      const dateLabel = matched ? matched.label : dateIso;
      const timeOptions = await buildTimeOptionsForDate(ctx, dateIso);
      const flex = buildCardSelectFlex({
        altText: 'ご希望の時間を選んでください',
        heading: 'ご希望の時間を選んでください',
        subheading: `${dateLabel} のご希望時間`,
        options: timeOptions.map((t) => ({
          label: t.full ? `${t.label}（満枠）` : t.label,
          data: `action=selectTime&value=${t.iso}`,
          displayText: t.full ? `${t.label}（満枠）` : t.label,
          disabled: t.full,
        })),
        footerOptions: [
          {
            label: '← 日付を選びなおす',
            data: 'action=backToDate',
            displayText: '日付を選びなおす',
          },
        ],
      });
      // replyTokenは1回しか使えないため、案内メッセージとカードを1回のreplyで両方送る
      return ctx.client.replyMessage(event.replyToken, [
        {
          type: 'text',
          text: '申し訳ございません、ちょうどこの時間は満枠になってしまいました。他の時間をお選びください。',
        },
        flex,
      ]);
    }

    // 「予約変更」フローの場合は、氏名等の再入力はせず、この時点で変更を確定させる
    if (session.mode === 'reschedule' && session.target_reservation_id) {
      return finalizeReschedule(ctx, event, lineUserId, session, datetimeIso);
    }

    await updateSession(ctx, lineUserId, { temp_datetime: datetimeIso, state: 'INFO_NAME' });
    return ctx.client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'お名前を教えてください（例：山田 花子）',
    });
  }

  // 予約が複数ある場合に、対象の予約を選んでもらった後の遷移
  if (action === 'selectReservation') {
    const rid = params.get('rid');
    const { data: reservation } = await supabase
      .from('reservations')
      .select('*')
      .eq('clinic_id', ctx.clinicId)
      .eq('id', rid)
      .maybeSingle();

    if (!reservation || reservation.status !== 'reserved') {
      return ctx.client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'このご予約はすでに変更・キャンセル済み、または見つかりませんでした。',
      });
    }

    return ctx.client.replyMessage(event.replyToken, buildChangeCancelOptionsFlex(reservation));
  }

  // 「変更」「キャンセル」メニューでの選択（cxlMenu = cancel/change menu）
  if (action === 'cxlMenu') {
    const value = params.get('value');
    const rid = params.get('rid');

    // 二重操作対策：この時点で予約がまだ有効か再確認する
    const { data: reservation } = await supabase
      .from('reservations')
      .select('*')
      .eq('clinic_id', ctx.clinicId)
      .eq('id', rid)
      .maybeSingle();

    if (!reservation || reservation.status !== 'reserved') {
      return ctx.client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'このご予約はすでに変更・キャンセル済み、または見つかりませんでした。',
      });
    }

    if (value === 'change') {
      await updateSession(ctx, lineUserId, {
        mode: 'reschedule',
        target_reservation_id: reservation.id,
        state: 'DATE',
        temp_date: null,
        temp_datetime: null,
      });
      const dateOptions = buildDateOptions();
      const flex = buildCardSelectFlex({
        altText: 'ご希望の新しい日付を選んでください',
        heading: 'ご希望の新しい日付を選んでください',
        subheading: `現在のご予約（${formatDatetime(reservation.scheduled_at)}）を変更します`,
        options: dateOptions.map((d) => ({
          label: d.label,
          data: `action=selectDate&value=${d.iso}`,
          displayText: d.label,
        })),
      });
      return ctx.client.replyMessage(event.replyToken, flex);
    }

    if (value === 'cancel') {
      const flex = buildCardSelectFlex({
        altText: 'ご予約のキャンセル確認',
        heading: '本当にキャンセルしますか？',
        subheading: `対象のご予約：${formatDatetime(reservation.scheduled_at)}`,
        options: [
          {
            label: 'はい、キャンセルする',
            data: `action=cancelConfirm&value=yes&rid=${reservation.id}`,
            displayText: 'キャンセルする',
          },
          {
            label: 'いいえ、やめる',
            data: `action=cancelConfirm&value=no&rid=${reservation.id}`,
            displayText: 'キャンセルをやめる',
          },
        ],
      });
      return ctx.client.replyMessage(event.replyToken, flex);
    }
  }

  // キャンセルの最終確認（はい/いいえ）
  if (action === 'cancelConfirm') {
    const value = params.get('value');
    const rid = params.get('rid');

    if (value === 'no') {
      return ctx.client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'キャンセルを取りやめました。',
      });
    }

    const { data: reservation } = await supabase
      .from('reservations')
      .select('*')
      .eq('clinic_id', ctx.clinicId)
      .eq('id', rid)
      .maybeSingle();

    if (!reservation || reservation.status !== 'reserved') {
      return ctx.client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'このご予約はすでに処理済み、または見つかりませんでした。',
      });
    }

    const { error: cancelUpdateError } = await supabase
      .from('reservations')
      .update({ status: 'cancelled' })
      .eq('id', rid);

    if (cancelUpdateError) {
      // 更新に失敗した場合は、患者に「キャンセル完了」と誤って伝えないようにする
      console.error(`[cancel] 予約 ${rid} のキャンセル処理に失敗しました:`, cancelUpdateError.message);
      return ctx.client.replyMessage(event.replyToken, {
        type: 'text',
        text: '申し訳ございません、キャンセル処理に失敗しました。お手数ですがクリニックまでご連絡ください。',
      });
    }

    // Googleカレンダー側は削除せず「キャンセル済み」として強調表示する（失敗しても予約キャンセル自体は完了させる）
    if (reservation.calendar_event_id) {
      const result = await markCalendarEventCancelled({ eventId: reservation.calendar_event_id });
      if (!result.ok && !result.skipped) {
        console.error(
          `[calendar] 予約 ${reservation.reservation_no} のキャンセル反映に失敗しました: ${result.error}`
        );
      }
    }

    return ctx.client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        `${formatDatetime(reservation.scheduled_at)}のご予約のキャンセルを承りました。\n` +
        `またのご利用をお待ちしております。`,
    });
  }

  if (action === 'backToDate') {
    await updateSession(ctx, lineUserId, { temp_date: null, state: 'DATE' });
    return sendDateCards(ctx, event.replyToken);
  }

  // 想定外のpostbackは最初から案内し直す
  await resetSession(ctx, lineUserId);
  return sendDateCards(ctx, event.replyToken);
}

// ---- LINEイベントハンドラ ----
async function handleEvent(ctx, event) {
  if (event.type === 'message' && event.message.type === 'text') {
    return handleTextMessage(ctx, event);
  }
  if (event.type === 'postback') {
    return handlePostback(ctx, event);
  }
  return Promise.resolve(null);
}

// 予約ごとの問診フォームURLを組み立てる。
// BASE_URL が未設定の場合は null を返し、呼び出し側は案内メッセージを送らない
// （＝環境変数が無くても既存の予約フローは壊れない）。
function buildQuestionnaireUrl(reservationId) {
  const base = process.env.BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/questionnaire?reservation_id=${reservationId}`;
}

// サーバーのタイムゾーン(Render等ではUTC)に関係なく、常にJSTで表示するための整形関数
function formatDatetime(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');

  // 曜日はJST基準の年月日から算出する（Dateのローカルgetterはサーバーのタイムゾーンに依存するため使わない）
  const jstMs = d.getTime() + JST_OFFSET_MINUTES * 60 * 1000;
  const weekday = new Date(jstMs).getUTCDay();

  return `${month}/${day}(${WEEKDAY_JA[weekday]}) ${hour}:${minute}`;
}

// ---- ルーティング ----
// 注意: express.json() は admin.js / platformAdmin.js 側の router 内だけに限定して適用している。
// ここでグローバルに app.use(express.json()) すると、/webhook が必要とする
// 生ボディ（署名検証用）が壊れてしまうため、絶対にここには追加しないこと。
//
// ---- マルチクリニックSaaS化 Phase 3 ----
// /webhook/:clinicId のように医院ごとのURLで受けられるようにしつつ、
// :clinicId を省略した従来の /webhook でのアクセスも既存クリニックとして
// 引き続き動作するようにしている（LINE Developersコンソール側の設定変更が不要）。
//
// 署名検証は以前は line.middleware(config) という「起動時に固定されたチャネルシークレット」
// を使う仕組みに任せていたが、医院ごとにチャネルシークレットが異なるため、
// リクエストが来るたびに該当医院のチャネルシークレットで検証する方式に変更している。
// そのため、生ボディを自前で受け取る express.raw() をこのルートにだけ適用し、
// line.validateSignature() で手動検証している。
app.post('/webhook/:clinicId?', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const clinicRow = await fetchClinicRow(supabase, req.params.clinicId);

    if (!clinicRow || clinicRow.status === 'suspended') {
      // 医院が見つからない、または利用停止中。不正リクエスト対策として200で早期終了する
      console.error(`[webhook] 医院が見つからないか停止中です（path=${req.params.clinicId || '(未指定)'}）`);
      return res.status(200).end();
    }

    const ctx = buildClinicContext(clinicRow);

    const signature = req.headers['x-line-signature'];
    let isValid = false;
    try {
      isValid = line.validateSignature(req.body, ctx.channelSecret, signature);
    } catch (sigErr) {
      console.error(`[webhook] 署名検証中にエラーが発生しました（clinicId=${ctx.clinicId}）:`, sigErr.message);
    }
    if (!isValid) {
      console.error(`[webhook] 署名検証に失敗しました（clinicId=${ctx.clinicId}）`);
      return res.status(401).end();
    }

    const bodyJson = JSON.parse(req.body.toString('utf8'));
    await Promise.all((bodyJson.events || []).map((event) => handleEvent(ctx, event)));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ---- 管理画面・問診フォームのJSON API ----
app.use('/api', createAdminRouter(supabase));

// ---- 運営者ダッシュボード・リンク集のJSON API（Phase 5）----
// platform_admins に登録された運営者のみアクセス可能。service_roleキーはサーバー側のみで使用。
app.use('/api/platform', createPlatformAdminRouter(supabase));

// ---- 管理画面・問診フォーム・運営者ダッシュボード・リンク集の静的ページ ----
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/questionnaire', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'questionnaire.html'));
});
app.get('/platform-admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'platform-admin.html'));
});
app.get('/operator-links', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'operator-links.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('CLIVA LINE webhook is running.');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Webhook server listening on port ${port}`);
});
