// admin.js
// ------------------------------------------------------------------
// 管理画面（/admin）と問診フォーム（/questionnaire）向けのJSON APIルーター。
//
// ---- マルチクリニックSaaS化 Phase 4（2026-07-10）----
// 医院管理者ログイン（Supabase Auth）を追加し、/reservations 系のエンドポイントは
// ログインした医院管理者のみアクセスできるようにした。ログインユーザーの
// auth_user_id を clinic_admins テーブルで引いて clinic_id を特定し、
// 以降のクエリはすべてその clinic_id で絞り込む（他医院のデータは一切見えない）。
//
// 問診フォーム系のエンドポイント（/questionnaire/:reservationId）は、患者本人が
// LINEから届いたリンクでログインなしにアクセスするものなので、認証対象からは
// 意図的に外している（これは既知の別課題として PROJECT_OVERVIEW.md に記録済み）。
// ------------------------------------------------------------------

const express = require('express');

// ログインした医院管理者かどうかを確認し、req.clinicId / req.adminUser を設定するミドルウェア。
// /reservations 系のルートにのみ適用する（/questionnaire には適用しない）。
function requireClinicAdmin(supabase) {
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

    const { data: adminRow, error: adminError } = await supabase
      .from('clinic_admins')
      .select('clinic_id, role')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();

    if (adminError) {
      console.error('[admin] clinic_admins取得に失敗しました:', adminError.message);
      return res.status(500).json({ error: '権限確認に失敗しました' });
    }
    if (!adminRow) {
      return res.status(403).json({ error: 'このアカウントには医院の管理権限がありません' });
    }

    req.clinicId = adminRow.clinic_id;
    req.adminUser = userData.user;
    next();
  };
}

function createAdminRouter(supabase) {
  const router = express.Router();
  router.use(express.json());

  const requireAuth = requireClinicAdmin(supabase);

  function shapeReservation(row) {
    const patient = row.patients || {};
    const questionnaire = Array.isArray(row.medical_questionnaires)
      ? row.medical_questionnaires[0]
      : row.medical_questionnaires;
    return {
      id: row.id,
      reservation_no: row.reservation_no,
      scheduled_at: row.scheduled_at,
      name: row.patient_name || patient.name || '',
      phone: row.patient_phone || patient.phone || '',
      symptom: row.symptom || '',
      status: row.status,
      source: row.source,
      department: row.department,
      memo: row.memo,
      questionnaire_submitted: Boolean(questionnaire),
      questionnaire: questionnaire || null,
      created_at: row.created_at,
    };
  }

  const SELECT_WITH_JOINS =
    '*, patients(name, phone), medical_questionnaires(id, birth_date, gender, consult_content, symptom_since, current_medication, allergies, medical_history, updated_at)';

  router.get('/reservations', requireAuth, async (req, res) => {
    const view = req.query.view === 'cancelled' ? 'cancelled' : 'list';

    let query = supabase.from('reservations').select(SELECT_WITH_JOINS).eq('clinic_id', req.clinicId);

    if (view === 'cancelled') {
      query = query.eq('status', 'cancelled').order('scheduled_at', { ascending: false });
    } else {
      query = query.in('status', ['reserved', 'visited']).order('scheduled_at', { ascending: true });
    }

    const { data, error } = await query;
    if (error) {
      console.error('[admin] 予約一覧の取得に失敗しました:', error.message);
      return res.status(500).json({ error: '予約一覧の取得に失敗しました' });
    }

    const shaped = (data || []).map(shapeReservation);

    if (view === 'list') {
      const nowMs = Date.now();
      shaped.forEach((r) => {
        if (r.status === 'reserved' && new Date(r.scheduled_at).getTime() < nowMs) {
          const diffMin = Math.max(0, Math.floor((nowMs - new Date(r.scheduled_at).getTime()) / 60000));
          r.display_state = 'overdue';
          r.overdue_minutes = diffMin;
          r.overdue_label =
            diffMin < 60 ? `${diffMin}分経過` : `${Math.floor(diffMin / 60)}時間${diffMin % 60}分経過`;
        } else if (r.status === 'visited') {
          r.display_state = 'visited';
        } else {
          r.display_state = 'reserved';
        }
      });
    } else {
      shaped.forEach((r) => {
        r.display_state = 'cancelled';
      });
    }

    res.json({ reservations: shaped });
  });

  router.get('/reservations/:id', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('reservations')
      .select(SELECT_WITH_JOINS)
      .eq('id', req.params.id)
      .eq('clinic_id', req.clinicId)
      .maybeSingle();

    if (error) {
      console.error('[admin] 予約詳細の取得に失敗しました:', error.message);
      return res.status(500).json({ error: '予約詳細の取得に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '予約が見つかりません' });

    res.json({ reservation: shapeReservation(data) });
  });

  router.post('/reservations', requireAuth, async (req, res) => {
    const { name, phone, scheduled_at, symptom, source } = req.body || {};

    if (!name || !phone || !scheduled_at) {
      return res.status(400).json({ error: '氏名・電話番号・予約日時は必須です' });
    }
    const allowedSources = ['phone', 'walk_in', 'staff'];
    if (!allowedSources.includes(source)) {
      return res.status(400).json({ error: '予約経路は 電話・直接来院・受付入力 のいずれかを選択してください' });
    }

    try {
      let { data: patient } = await supabase
        .from('patients')
        .select('*')
        .eq('clinic_id', req.clinicId)
        .eq('phone', phone)
        .is('line_user_id', null)
        .maybeSingle();

      if (!patient) {
        const { data: created, error: createErr } = await supabase
          .from('patients')
          .insert({ clinic_id: req.clinicId, name, phone, line_user_id: null })
          .select()
          .single();
        if (createErr) throw createErr;
        patient = created;
      } else {
        await supabase.from('patients').update({ name, phone }).eq('id', patient.id);
      }

      const { data: reservationNo, error: noError } = await supabase.rpc('next_reservation_no');
      const finalReservationNo =
        noError || !reservationNo ? `A-${Math.floor(1000 + Math.random() * 9000)}` : reservationNo;

      const { data: reservation, error: insertErr } = await supabase
        .from('reservations')
        .insert({
          clinic_id: req.clinicId,
          patient_id: patient.id,
          department: null,
          scheduled_at,
          symptom: symptom || null,
          status: source === 'walk_in' ? 'visited' : 'reserved',
          source,
          reservation_no: finalReservationNo,
          patient_name: name,
          patient_phone: phone,
        })
        .select(SELECT_WITH_JOINS)
        .single();
      if (insertErr) throw insertErr;

      res.status(201).json({ reservation: shapeReservation(reservation) });
    } catch (err) {
      console.error('[admin] 新規予約の作成に失敗しました:', err.message || err);
      res.status(500).json({ error: '新規予約の作成に失敗しました' });
    }
  });

  router.patch('/reservations/:id/status', requireAuth, async (req, res) => {
    const { status } = req.body || {};
    if (!['visited', 'cancelled', 'reserved'].includes(status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }

    const { data, error } = await supabase
      .from('reservations')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('clinic_id', req.clinicId)
      .select(SELECT_WITH_JOINS)
      .maybeSingle();

    if (error) {
      console.error('[admin] ステータス更新に失敗しました:', error.message);
      return res.status(500).json({ error: 'ステータス更新に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '予約が見つかりません' });

    res.json({ reservation: shapeReservation(data) });
  });

  router.get('/questionnaire/:reservationId', async (req, res) => {
    const { data: reservation, error } = await supabase
      .from('reservations')
      .select('id, scheduled_at, status, patient_name, patients(name, phone), medical_questionnaires(*)')
      .eq('id', req.params.reservationId)
      .maybeSingle();

    if (error) {
      console.error('[questionnaire] 予約情報の取得に失敗しました:', error.message);
      return res.status(500).json({ error: '予約情報の取得に失敗しました' });
    }
    if (!reservation) return res.status(404).json({ error: '予約が見つかりません' });

    const questionnaire = Array.isArray(reservation.medical_questionnaires)
      ? reservation.medical_questionnaires[0]
      : reservation.medical_questionnaires;

    res.json({
      reservation: {
        id: reservation.id,
        scheduled_at: reservation.scheduled_at,
        name: reservation.patient_name || reservation.patients?.name || '',
      },
      questionnaire: questionnaire || null,
    });
  });

  router.post('/questionnaire/:reservationId', async (req, res) => {
    const reservationId = req.params.reservationId;
    const {
      birth_date,
      gender,
      consult_content,
      symptom_since,
      current_medication,
      allergies,
      medical_history,
    } = req.body || {};

    if (!consult_content || !symptom_since) {
      return res.status(400).json({ error: '本日相談したい内容と症状の時期は必須です' });
    }

    const { data: reservation } = await supabase
      .from('reservations')
      .select('id')
      .eq('id', reservationId)
      .maybeSingle();
    if (!reservation) return res.status(404).json({ error: '予約が見つかりません' });

    const { data, error } = await supabase
      .from('medical_questionnaires')
      .upsert(
        {
          reservation_id: reservationId,
          birth_date: birth_date || null,
          gender: gender || null,
          consult_content,
          symptom_since,
          current_medication: current_medication || null,
          allergies: allergies || null,
          medical_history: medical_history || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'reservation_id' }
      )
      .select()
      .single();

    if (error) {
      console.error('[questionnaire] 問診の保存に失敗しました:', error.message);
      return res.status(500).json({ error: '問診の保存に失敗しました' });
    }

    res.json({ questionnaire: data });
  });

  return router;
}

module.exports = { createAdminRouter };
