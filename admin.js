// admin.js
// ------------------------------------------------------------------
// 管理画面（/admin）と問診フォーム（/questionnaire）向けのJSON APIルーター。
// 既存のLINE予約フロー（index.js）には一切手を入れず、独立したモジュールとして
// 追加する。将来ログイン認証を追加する際は、この router に auth ミドルウェアを
// 差し込むだけで済むようにしてある。
// ------------------------------------------------------------------

const express = require('express');

function createAdminRouter(supabase) {
  const router = express.Router();
  router.use(express.json());

  // 予約1件を、一覧・詳細で使いやすい形に整形する
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

  // ---- GET /api/reservations?view=list|cancelled ----
  // view=list      : status = reserved / visited （予約一覧タブ。キャンセル済みは含まない）
  //                  reserved のうち予約時刻を過ぎているものには display_state='overdue' を付与する
  // view=cancelled : status = cancelled （キャンセル済みタブ）
  router.get('/reservations', async (req, res) => {
    const view = req.query.view === 'cancelled' ? 'cancelled' : 'list';

    let query = supabase.from('reservations').select(SELECT_WITH_JOINS);

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
          r.display_state = 'overdue'; // 未来院（予約時刻を過ぎているが来院済みになっていない）
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

  // ---- GET /api/reservations/:id ----
  router.get('/reservations/:id', async (req, res) => {
    const { data, error } = await supabase
      .from('reservations')
      .select(SELECT_WITH_JOINS)
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) {
      console.error('[admin] 予約詳細の取得に失敗しました:', error.message);
      return res.status(500).json({ error: '予約詳細の取得に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '予約が見つかりません' });

    res.json({ reservation: shapeReservation(data) });
  });

  // ---- POST /api/reservations （新規予約追加：電話・直接来院・受付入力） ----
  router.post('/reservations', async (req, res) => {
    const { name, phone, scheduled_at, symptom, source } = req.body || {};

    if (!name || !phone || !scheduled_at) {
      return res.status(400).json({ error: '氏名・電話番号・予約日時は必須です' });
    }
    const allowedSources = ['phone', 'walk_in', 'staff'];
    if (!allowedSources.includes(source)) {
      return res.status(400).json({ error: '予約経路は 電話・直接来院・受付入力 のいずれかを選択してください' });
    }

    try {
      // 電話番号で既存の（LINE未経由の）患者を探し、いなければ新規作成する
      let { data: patient } = await supabase
        .from('patients')
        .select('*')
        .eq('phone', phone)
        .is('line_user_id', null)
        .maybeSingle();

      if (!patient) {
        const { data: created, error: createErr } = await supabase
          .from('patients')
          .insert({ name, phone, line_user_id: null })
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
          patient_id: patient.id,
          department: null,
          scheduled_at,
          symptom: symptom || null,
          status: 'reserved',
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

  // ---- PATCH /api/reservations/:id/status （来院済み・キャンセル済みに更新） ----
  router.patch('/reservations/:id/status', async (req, res) => {
    const { status } = req.body || {};
    if (!['visited', 'cancelled', 'reserved'].includes(status)) {
      return res.status(400).json({ error: '不正なステータスです' });
    }

    const { data, error } = await supabase
      .from('reservations')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select(SELECT_WITH_JOINS)
      .maybeSingle();

    if (error) {
      console.error('[admin] ステータス更新に失敗しました:', error.message);
      return res.status(500).json({ error: 'ステータス更新に失敗しました' });
    }
    if (!data) return res.status(404).json({ error: '予約が見つかりません' });

    res.json({ reservation: shapeReservation(data) });
  });

  // ---- GET /api/questionnaire/:reservationId （問診フォーム表示用） ----
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

  // ---- POST /api/questionnaire/:reservationId （問診フォーム送信・upsert） ----
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

    // 予約の存在確認
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
