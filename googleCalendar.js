// googleCalendar.js
// ------------------------------------------------------------------
// Google カレンダー連携モジュール
//
// 予約確定時に Google カレンダーへ 30 分枠の予定を自動作成する。
// 認証はサービスアカウント方式（サーバー間認証）を採用し、患者・スタッフの
// ブラウザ操作なしでバックグラウンド登録できる。
//
// 設計方針（重要）:
//   - 認証情報は .env で管理し、コードに直書きしない。
//   - 「予約処理を壊さない」ことを最優先にする。具体的には:
//       * 認証情報が未設定なら何もせず { ok:false, skipped:true } を返す
//         （＝カレンダー連携なしでもローカル開発・既存挙動がそのまま動く）
//       * API 呼び出しが失敗しても例外を外へ投げず、{ ok:false, error } を返す
//         → 呼び出し側は予約自体は完了させたまま、失敗ログだけ残せる
// ------------------------------------------------------------------

const { google } = require('googleapis');

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar'];
const EVENT_DURATION_MIN = 30;       // 予定は 30 分枠
const TIME_ZONE = 'Asia/Tokyo';      // タイムゾーンは固定
const JST_OFFSET_MINUTES = 9 * 60;   // JSTのUTCからのオフセット（分）

// JWT クライアントは使い回す（毎回作らない）
let cachedCalendar = null;

// .env に格納した秘密鍵は改行が "\n" という文字列でエスケープされて入るため、
// 実際の改行コードへ戻してから使う。
function normalizePrivateKey(raw) {
  if (!raw) return '';
  return raw.replace(/\\n/g, '\n');
}

// カレンダー連携に必要な環境変数が揃っているか
function isCalendarConfigured() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY &&
      process.env.GOOGLE_CALENDAR_ID
  );
}

// 認証済み Calendar クライアントを取得（初回だけ生成してキャッシュ）
function getCalendarClient() {
  if (cachedCalendar) return cachedCalendar;

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
    scopes: CALENDAR_SCOPES,
  });

  cachedCalendar = google.calendar({ version: 'v3', auth });
  return cachedCalendar;
}

// 説明欄用に Asia/Tokyo 表記の読みやすい日時文字列を作る
function formatJst(iso) {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

// JST の壁時計としての「オフセットなし」日時文字列を作る（例: 2026-07-12T16:00:00）
// Google Calendar API へ渡す際、UTCの Z 付き時刻と timeZone を同時に指定すると
// 内部でタイムゾーン分が二重に適用されてしまう仕様の落とし穴があるため、
// 「オフセットなしのローカル時刻文字列 + timeZone」という Google 推奨の形式に統一する。
function toJstNaiveString(msUtc) {
  const jstMs = msUtc + JST_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(jstMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}:${mi}:${s}`;
}

// 予定の説明欄テキストを組み立てる
function buildDescription({ name, phone, symptom, scheduledAt, lineUserId }) {
  const lines = [
    `患者名: ${name || '(未入力)'}`,
    `電話番号: ${phone || '(未入力)'}`,
    `主訴: ${symptom || '(未入力)'}`,
    `予約日時: ${formatJst(scheduledAt)}`,
  ];
  // LINE ユーザー ID は取得できる場合のみ追記
  if (lineUserId) {
    lines.push(`LINEユーザーID: ${lineUserId}`);
  }
  return lines.join('\n');
}

/**
 * Google カレンダーに予約予定を作成する。
 *
 * @param {Object}  params
 * @param {string}  params.name         患者名
 * @param {string}  params.phone        電話番号
 * @param {string}  params.symptom      主訴
 * @param {string}  params.scheduledAt  予約日時（ISO 8601 文字列）
 * @param {string} [params.lineUserId]  LINE ユーザー ID（任意）
 * @returns {Promise<{ok:boolean, skipped?:boolean, eventId?:string, htmlLink?:string, error?:string}>}
 *          例外は投げない。呼び出し側は戻り値で成否を判定する。
 */
async function createCalendarEvent({ name, phone, symptom, scheduledAt, lineUserId } = {}) {
  // 未設定ならスキップ（既存の予約フローを一切壊さない）
  if (!isCalendarConfigured()) {
    console.warn(
      '[calendar] Google カレンダー未設定のためスキップしました。' +
        'GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY / GOOGLE_CALENDAR_ID を確認してください。'
    );
    return { ok: false, skipped: true };
  }

  // 日時の妥当性チェック
  const startMs = new Date(scheduledAt).getTime();
  if (!scheduledAt || Number.isNaN(startMs)) {
    console.error(`[calendar] scheduledAt が不正なため予定を作成できません: ${scheduledAt}`);
    return { ok: false, skipped: true };
  }

  const startIso = toJstNaiveString(startMs);
  const endIso = toJstNaiveString(startMs + EVENT_DURATION_MIN * 60 * 1000);

  const requestBody = {
    summary: `CLIVA予約：${name || '患者名未入力'}`,
    description: buildDescription({ name, phone, symptom, scheduledAt, lineUserId }),
    start: { dateTime: startIso, timeZone: TIME_ZONE },
    end: { dateTime: endIso, timeZone: TIME_ZONE },
  };

  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody,
    });
    console.log(`[calendar] 予定を作成しました eventId=${res.data.id}`);
    return { ok: true, eventId: res.data.id, htmlLink: res.data.htmlLink };
  } catch (err) {
    // Google API のエラーはレスポンスボディに詳細が入るので優先して取り出す
    const detail =
      (err && err.response && err.response.data && JSON.stringify(err.response.data)) ||
      (err && err.message) ||
      String(err);
    console.error(`[calendar] 予定の作成に失敗しました: ${detail}`);
    return { ok: false, error: detail };
  }
}

/**
 * 既存のGoogleカレンダー予定の日時・内容を更新する（予約の日時変更用）。
 * createCalendarEventと同じ形式のリクエストボディを組み立て、insertの代わりにpatchする。
 *
 * @param {Object} params
 * @param {string} params.eventId       更新対象のGoogleカレンダーイベントID
 * @param {string} params.name
 * @param {string} params.phone
 * @param {string} params.symptom
 * @param {string} params.scheduledAt   新しい予約日時（ISO 8601文字列）
 * @param {string} [params.lineUserId]
 * @returns {Promise<{ok:boolean, skipped?:boolean, eventId?:string, error?:string}>}
 */
async function updateCalendarEvent({ eventId, name, phone, symptom, scheduledAt, lineUserId } = {}) {
  if (!isCalendarConfigured()) {
    console.warn('[calendar] Google カレンダー未設定のため更新をスキップしました。');
    return { ok: false, skipped: true };
  }
  if (!eventId) {
    console.error('[calendar] eventId が指定されていないため更新できません。');
    return { ok: false, skipped: true };
  }

  const startMs = new Date(scheduledAt).getTime();
  if (!scheduledAt || Number.isNaN(startMs)) {
    console.error(`[calendar] scheduledAt が不正なため予定を更新できません: ${scheduledAt}`);
    return { ok: false, skipped: true };
  }

  const startIso = toJstNaiveString(startMs);
  const endIso = toJstNaiveString(startMs + EVENT_DURATION_MIN * 60 * 1000);

  const requestBody = {
    summary: `CLIVA予約：${name || '患者名未入力'}`,
    description: buildDescription({ name, phone, symptom, scheduledAt, lineUserId }),
    start: { dateTime: startIso, timeZone: TIME_ZONE },
    end: { dateTime: endIso, timeZone: TIME_ZONE },
  };

  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.patch({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId,
      requestBody,
    });
    console.log(`[calendar] 予定を更新しました eventId=${res.data.id}`);
    return { ok: true, eventId: res.data.id };
  } catch (err) {
    const detail =
      (err && err.response && err.response.data && JSON.stringify(err.response.data)) ||
      (err && err.message) ||
      String(err);
    console.error(`[calendar] 予定の更新に失敗しました: ${detail}`);
    return { ok: false, error: detail };
  }
}

// キャンセル済みの予定を目立たせるための色（Googleカレンダーの標準色ID。'11' はトマト/赤系）
const CANCELLED_COLOR_ID = '11';
const CANCELLED_PREFIX = '【キャンセル済み】';

/**
 * Googleカレンダーの予定を「キャンセル済み」として強調表示する。
 * 予定自体は削除せず、タイトルに接頭辞を付け、色を変更し、説明欄にも注記を追加する。
 * （削除しない理由：スタッフが後から履歴を確認できるようにするため）
 *
 * @param {Object} params
 * @param {string} params.eventId  対象のGoogleカレンダーイベントID
 * @returns {Promise<{ok:boolean, skipped?:boolean, eventId?:string, error?:string}>}
 */
async function markCalendarEventCancelled({ eventId } = {}) {
  if (!isCalendarConfigured()) {
    console.warn('[calendar] Google カレンダー未設定のためキャンセル反映をスキップしました。');
    return { ok: false, skipped: true };
  }
  if (!eventId) {
    console.error('[calendar] eventId が指定されていないためキャンセル反映できません。');
    return { ok: false, skipped: true };
  }

  try {
    const calendar = getCalendarClient();
    const { data: existing } = await calendar.events.get({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId,
    });

    const alreadyMarked = (existing.summary || '').startsWith(CANCELLED_PREFIX);
    const newSummary = alreadyMarked ? existing.summary : `${CANCELLED_PREFIX}${existing.summary || ''}`;
    const newDescription = alreadyMarked
      ? existing.description
      : `${existing.description || ''}\n\n※このご予約は患者様によりキャンセルされました。`;

    const res = await calendar.events.patch({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId,
      requestBody: {
        summary: newSummary,
        description: newDescription,
        colorId: CANCELLED_COLOR_ID,
      },
    });
    console.log(`[calendar] 予定をキャンセル済み表示にしました eventId=${res.data.id}`);
    return { ok: true, eventId: res.data.id };
  } catch (err) {
    const detail =
      (err && err.response && err.response.data && JSON.stringify(err.response.data)) ||
      (err && err.message) ||
      String(err);
    console.error(`[calendar] キャンセル反映に失敗しました: ${detail}`);
    return { ok: false, error: detail };
  }
}

module.exports = { createCalendarEvent, updateCalendarEvent, markCalendarEventCancelled, isCalendarConfigured };
