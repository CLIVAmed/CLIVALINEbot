// ============================================================
// CLIVA マルチクリニックSaaS化 Phase 3
// リクエストごとに「どの医院宛てか」を解決し、その医院用のLINEクライアント・
// 診療枠設定（診療時間・枠の刻み・同時受付上限）をまとめた ctx を組み立てるモジュール
// ============================================================

const line = require('@line/bot-sdk');
const { decryptSecret } = require('./crypto');

// 既存クリニック（今まで唯一運用していた医院）の webhook_path。
// 旧URL（/webhook、clinicIdパラメータなし）でアクセスされた場合はこの医院として扱う。
// これにより、LINE Developersコンソール側のWebhook URL設定を変更しなくても
// 既存クリニックはこれまで通り動作し続ける。
const DEFAULT_WEBHOOK_PATH = 'clinic_main_existing';

// clinics取得に失敗した場合の保険（本来はここに来ないはずだが、安全側の既定値として残す）
const FALLBACK_BUSINESS_HOURS = [
  { start: '10:00', end: '13:00' },
  { start: '15:00', end: '18:00' },
];
const FALLBACK_SLOT_INTERVAL_MIN = 30;
const FALLBACK_MAX_RESERVATIONS_PER_SLOT = 3;

// clinics テーブルの行を短時間キャッシュする（webhook_path をキーに、60秒）
const clinicRowCache = new Map(); // webhookPath -> { row, fetchedAt }
const CLINIC_CACHE_TTL_MS = 60 * 1000;

/**
 * 診療時間・枠間隔から "9:00" 形式の時間ラベル一覧を生成する
 * 医院ごとの business_hours / slot_interval_min を引数で受け取る純粋関数
 * （index.js旧版の generateTimeSlots() をグローバル定数非依存にしたもの）
 */
function generateTimeSlots(businessHours, slotIntervalMin) {
  const slots = [];
  for (const range of businessHours) {
    const [startH, startM] = range.start.split(':').map(Number);
    const [endH, endM] = range.end.split(':').map(Number);
    let cur = startH * 60 + startM;
    const endTotalMin = endH * 60 + endM;
    while (cur + slotIntervalMin <= endTotalMin) {
      const h = Math.floor(cur / 60);
      const m = cur % 60;
      slots.push(`${h}:${String(m).padStart(2, '0')}`);
      cur += slotIntervalMin;
    }
  }
  return slots;
}

/**
 * webhookPathParam（URLの :clinicId 部分。未指定なら undefined）から
 * clinics テーブルの該当行を取得する（60秒キャッシュつき）
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string|undefined} webhookPathParam
 * @returns {Promise<object|null>} clinics の行。見つからない場合はnull
 */
async function fetchClinicRow(supabase, webhookPathParam) {
  const webhookPath = webhookPathParam || DEFAULT_WEBHOOK_PATH;

  const cached = clinicRowCache.get(webhookPath);
  if (cached && Date.now() - cached.fetchedAt < CLINIC_CACHE_TTL_MS) {
    return cached.row;
  }

  const { data, error } = await supabase
    .from('clinics')
    .select('*')
    .eq('webhook_path', webhookPath)
    .maybeSingle();

  if (error) {
    console.error(`[clinicContext] clinics取得に失敗しました（webhook_path=${webhookPath}）: ${error.message}`);
    return null;
  }

  clinicRowCache.set(webhookPath, { row: data, fetchedAt: Date.now() });
  return data;
}

/**
 * clinics の1行から、このリクエスト処理全体で使い回す ctx を組み立てる。
 * LINEチャネル情報が暗号化列に入っていればそれを復号して使い、
 * まだ入っていない場合（Phase 2完了直後など）は .env の値にフォールバックする。
 *
 * @param {object} clinicRow clinicsテーブルの1行
 * @returns {{
 *   clinicId: string,
 *   clinicRow: object,
 *   client: import('@line/bot-sdk').Client,
 *   channelSecret: string,
 *   clinicConfig: { businessHours: any, slotIntervalMin: number, maxReservationsPerSlot: number, timeSlots: string[] }
 * }}
 */
function buildClinicContext(clinicRow) {
  let channelAccessToken;
  let channelSecret;
  try {
    channelAccessToken = decryptSecret(clinicRow.line_channel_token_enc);
    channelSecret = decryptSecret(clinicRow.line_channel_secret_enc);
  } catch (err) {
    console.error(`[clinicContext] LINE認証情報の復号に失敗しました（clinicId=${clinicRow.id}）:`, err.message);
  }

  // 暗号化データが未設定（Phase 2完了直後の既存クリニックなど）の場合は、
  // 既存の .env の値にフォールバックする
  if (!channelAccessToken) channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelSecret) channelSecret = process.env.LINE_CHANNEL_SECRET;

  const client = new line.Client({ channelAccessToken, channelSecret });

  const businessHours = clinicRow.business_hours || FALLBACK_BUSINESS_HOURS;
  const slotIntervalMin = clinicRow.slot_interval_min || FALLBACK_SLOT_INTERVAL_MIN;
  const maxReservationsPerSlot = clinicRow.max_reservations_per_slot || FALLBACK_MAX_RESERVATIONS_PER_SLOT;

  const clinicConfig = {
    businessHours,
    slotIntervalMin,
    maxReservationsPerSlot,
    timeSlots: generateTimeSlots(businessHours, slotIntervalMin),
  };

  return {
    clinicId: clinicRow.id,
    clinicRow,
    client,
    channelSecret,
    clinicConfig,
  };
}

module.exports = {
  DEFAULT_WEBHOOK_PATH,
  fetchClinicRow,
  buildClinicContext,
  generateTimeSlots,
};
