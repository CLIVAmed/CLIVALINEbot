// platformAdmin.js
// Phase 5：運営者（プラットフォーム管理者）用API
//
// clinic_admins（各医院のスタッフ）とは別に、platform_adminsテーブルに
// 登録された「運営者」だけが使えるAPI群。
// ・全医院の一覧と稼働状況・予約件数の確認
// ・新規医院の登録（webhook_pathの自動発行、LINEチャネル情報の暗号化保存）
// ・医院ステータスの変更（trial / active / suspended）
//
// 重要：ここで使うsupabaseクライアントはservice_roleキーのもの（index.js側で生成）。
// service_roleキーはこのファイル＝サーバー側のコードの中だけで使われ、
// ブラウザ（platform-admin.html）に渡ることは一切ない。
//
// 注意：platform_adminsテーブルの実際の列は id / auth_user_id / created_at のみ
// （roleという列は存在しない）。以前のバージョンで誤って存在しない列を
// selectしてしまい、権限確認が500エラーになる不具合があったため修正済み。

const express = require('express');
const nodeCrypto = require('crypto'); // Node標準のcryptoモジュール（webhook_path生成用）
const { encryptSecret } = require('./crypto'); // CLIVA自作の暗号化ユーティリティ（LINE認証情報用）

const DEFAULT_BUSINESS_HOURS = {
  mon: ['09:00-12:30', '14:30-18:30'],
  tue: ['09:00-12:30', '14:30-18:30'],
  wed: ['09:00-12:30', '14:30-18:30'],
  thu: ['09:00-12:30', '14:30-18:30'],
  fri: ['09:00-12:30', '14:30-18:30'],
  sat: ['09:00-12:30'],
  sun: [],
};

// 運営者かどうかを確認するミドルウェア（clinic_adminsではなくplatform_adminsを見る）
function requirePlatformAdmin(supabase) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'ログインが必要です' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData || !userData.user) {
      return res.status(401).json({ error: 'ログイン情報が無効です。再度ログインしてください' });
    }

    // platform_adminsには id / auth_user_id / created_at しか列が無いため、id だけをselectする
    const { data: adminRow, error: adminError } = await supabase
      .from('platform_admins')
      .select('id')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();

    if (adminError) {
      return res.status(500).json({ error: '権限確認に失敗しました' });
    }
    if (!adminRow) {
      return res.status(403).json({ error: 'このアカウントには運営者権限がありません' });
    }

    req.platformAdminUser = userData.user;
    next();
  };
}

// 医院名などから安全なwebhook_pathを自動生成する
// 例："さくら歯科クリニック" → "clinic_a1b2c3d4e5f6"
function generateWebhookPath() {
  return 'clinic_' + nodeCrypto.randomBytes(6).toString('hex');
}

function createPlatformAdminRouter(supabase) {
  const router = express.Router();
  router.use(express.json());
  router.use(requirePlatformAdmin(supabase));

  // 医院一覧＋予約件数サマリを取得
  router.get('/clinics', async (req, res) => {
    const { data: clinics, error: clinicsError } = await supabase
      .from('clinics')
      .select('id, name, webhook_path, status, slot_interval_min, business_hours, max_reservations_per_slot, created_at')
      .order('created_at', { ascending: true });

    if (clinicsError) {
      return res.status(500).json({ error: '医院一覧の取得に失敗しました' });
    }

    // 予約件数は全件を取得して集計する（医院数・予約数が今後大きく増えた場合はビュー化を検討）
    const { data: reservations, error: reservationsError } = await supabase
      .from('reservations')
      .select('clinic_id, status');

    if (reservationsError) {
      return res.status(500).json({ error: '予約件数の集計に失敗しました' });
    }

    const summary = {};
    (reservations || []).forEach((r) => {
      if (!summary[r.clinic_id]) {
        summary[r.clinic_id] = { total: 0, reserved: 0, visited: 0, cancelled: 0 };
      }
      summary[r.clinic_id].total += 1;
      if (summary[r.clinic_id][r.status] !== undefined) {
        summary[r.clinic_id][r.status] += 1;
      }
    });

    const shaped = (clinics || []).map((c) => ({
      ...c,
      reservation_counts: summary[c.id] || { total: 0, reserved: 0, visited: 0, cancelled: 0 },
      has_line_credentials: undefined, // 下で明示的にセットする（暗号化済み値そのものは絶対に返さない）
    }));

    // LINE認証情報を設定済みかどうかだけをフラグで返す（暗号化された値自体は返さない）
    const { data: rawClinics } = await supabase
      .from('clinics')
      .select('id, line_channel_token_enc, line_channel_secret_enc');
    const credMap = {};
    (rawClinics || []).forEach((c) => {
      credMap[c.id] = Boolean(c.line_channel_token_enc && c.line_channel_secret_enc);
    });
    shaped.forEach((c) => {
      c.has_line_credentials = credMap[c.id] || false;
    });

    res.json({ clinics: shaped });
  });

  // 新規医院登録
  router.post('/clinics', async (req, res) => {
    const body = req.body || {};
    const name = (body.name || '').trim();
    const lineChannelAccessToken = body.line_channel_access_token || '';
    const lineChannelSecret = body.line_channel_secret || '';
    const slotIntervalMin = Number(body.slot_interval_min) || 30;
    const maxReservationsPerSlot = Number(body.max_reservations_per_slot) || 3;
    const businessHours = body.business_hours || DEFAULT_BUSINESS_HOURS;

    if (!name) {
      return res.status(400).json({ error: '医院名を入力してください' });
    }

    const webhookPath = generateWebhookPath();

    let tokenEnc = null;
    let secretEnc = null;
    try {
      if (lineChannelAccessToken) tokenEnc = encryptSecret(lineChannelAccessToken);
      if (lineChannelSecret) secretEnc = encryptSecret(lineChannelSecret);
    } catch (e) {
      return res.status(500).json({ error: 'LINE認証情報の暗号化に失敗しました' });
    }

    const { data, error } = await supabase
      .from('clinics')
      .insert({
        name,
        webhook_path: webhookPath,
        status: 'trial',
        slot_interval_min: slotIntervalMin,
        business_hours: businessHours,
        max_reservations_per_slot: maxReservationsPerSlot,
        line_channel_token_enc: tokenEnc,
        line_channel_secret_enc: secretEnc,
      })
      .select('id, name, webhook_path, status, created_at')
      .single();

    if (error) {
      return res.status(500).json({ error: '医院の登録に失敗しました: ' + error.message });
    }

    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      clinic: data,
      webhook_url: `${baseUrl}/webhook/${webhookPath}`,
    });
  });

  // 医院のLINE認証情報を更新（新規登録時に空だった場合や、ローテーションしたい場合）
  router.patch('/clinics/:id/line-credentials', async (req, res) => {
    const { line_channel_access_token: lineChannelAccessToken, line_channel_secret: lineChannelSecret } = req.body || {};
    if (!lineChannelAccessToken && !lineChannelSecret) {
      return res.status(400).json({ error: '更新するLINE認証情報を入力してください' });
    }

    const update = {};
    try {
      if (lineChannelAccessToken) update.line_channel_token_enc = encryptSecret(lineChannelAccessToken);
      if (lineChannelSecret) update.line_channel_secret_enc = encryptSecret(lineChannelSecret);
    } catch (e) {
      return res.status(500).json({ error: 'LINE認証情報の暗号化に失敗しました' });
    }

    const { data, error } = await supabase
      .from('clinics')
      .update(update)
      .eq('id', req.params.id)
      .select('id, name')
      .single();

    if (error) {
      return res.status(500).json({ error: '更新に失敗しました: ' + error.message });
    }
    res.json({ clinic: data });
  });

  // 医院ステータスの変更（trial / active / suspended）
  router.patch('/clinics/:id/status', async (req, res) => {
    const { status } = req.body || {};
    if (!['trial', 'active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }

    const { data, error } = await supabase
      .from('clinics')
      .update({ status })
      .eq('id', req.params.id)
      .select('id, name, status')
      .single();

    if (error) {
      return res.status(500).json({ error: '更新に失敗しました: ' + error.message });
    }
    res.json({ clinic: data });
  });

  return router;
}

module.exports = { createPlatformAdminRouter, requirePlatformAdmin, generateWebhookPath };
