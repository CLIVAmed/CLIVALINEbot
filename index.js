// CLIVA予約システム Webhookサーバー
// 患者からのLINEメッセージを受け取り、診療科選択→日時選択→氏名/電話/症状入力→予約確定
// の順に会話を進め、Supabase(PostgreSQL)に保存します。

require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const client = new line.Client(config);
const app = express();

const DEPARTMENTS = ['内科', '歯科', '皮膚科', '小児科', '整形外科', '心療内科'];

// ---- 日時の候補を簡易生成（今日・明日・明後日 × 4枠） ----
function buildDatetimeOptions() {
  const times = ['10:00', '14:00', '15:30', '17:00'];
  const days = [0, 1, 2].map((offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d;
  });
  const options = [];
  for (const day of days) {
    for (const t of times) {
      const [h, m] = t.split(':').map(Number);
      const dt = new Date(day);
      dt.setHours(h, m, 0, 0);
      const label = `${dt.getMonth() + 1}/${dt.getDate()} ${t}`;
      options.push({ label, iso: dt.toISOString() });
    }
  }
  return options.slice(0, 12); // クイックリプライは最大13個まで
}

// ---- セッション取得・更新 ----
async function getSession(lineUserId) {
  const { data } = await supabase
    .from('user_sessions')
    .select('*')
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (data) return data;

  const { data: created } = await supabase
    .from('user_sessions')
    .insert({ line_user_id: lineUserId, state: 'DEPT' })
    .select()
    .single();
  return created;
}

async function updateSession(lineUserId, patch) {
  await supabase
    .from('user_sessions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('line_user_id', lineUserId);
}

async function resetSession(lineUserId) {
  await supabase
    .from('user_sessions')
    .update({
      state: 'DEPT',
      temp_department: null,
      temp_datetime: null,
      temp_name: null,
      temp_phone: null,
      temp_symptom: null,
      updated_at: new Date().toISOString(),
    })
    .eq('line_user_id', lineUserId);
}

// ---- 予約確定処理 ----
async function finalizeReservation(lineUserId, session) {
  // 患者レコードを作成 or 取得
  let { data: patient } = await supabase
    .from('patients')
    .select('*')
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (!patient) {
    const { data: created } = await supabase
      .from('patients')
      .insert({ line_user_id: lineUserId, name: session.temp_name, phone: session.temp_phone })
      .select()
      .single();
    patient = created;
  } else {
    await supabase
      .from('patients')
      .update({ name: session.temp_name, phone: session.temp_phone })
      .eq('id', patient.id);
  }

  // 予約番号発行（例: A-1024）— schema.sql の next_reservation_no() を使用
  const { data: reservationNo, error: noError } = await supabase.rpc('next_reservation_no');
  const finalReservationNo = noError || !reservationNo ? `A-${Math.floor(1000 + Math.random() * 9000)}` : reservationNo;

  const { data: reservation } = await supabase
    .from('reservations')
    .insert({
      patient_id: patient.id,
      department: session.temp_department,
      scheduled_at: session.temp_datetime,
      symptom: session.temp_symptom,
      status: 'before',
      reservation_no: finalReservationNo,
    })
    .select()
    .single();

  await resetSession(lineUserId);
  return reservation;
}

// ---- LINEイベントハンドラ ----
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const lineUserId = event.source.userId;
  const text = event.message.text.trim();
  const session = await getSession(lineUserId);

  // 「予約」「予約したい」等のキーワードでいつでもリセットして最初から
  if (text.includes('予約') && session.state !== 'DEPT') {
    await resetSession(lineUserId);
  }

  switch (session.state) {
    case 'DEPT': {
      if (DEPARTMENTS.includes(text)) {
        await updateSession(lineUserId, { temp_department: text, state: 'DATETIME' });
        return replyDatetimeOptions(event.replyToken);
      }
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ご希望の診療科を選んでください🍀',
        quickReply: buildQuickReply(DEPARTMENTS),
      });
    }

    case 'DATETIME': {
      const options = buildDatetimeOptions();
      const matched = options.find((o) => o.label === text);
      if (matched) {
        await updateSession(lineUserId, { temp_datetime: matched.iso, state: 'INFO_NAME' });
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: 'お名前を教えてください（例：山田 花子）',
        });
      }
      return replyDatetimeOptions(event.replyToken);
    }

    case 'INFO_NAME': {
      await updateSession(lineUserId, { temp_name: text, state: 'INFO_PHONE' });
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'お電話番号を教えてください（例：090-1234-5678）',
      });
    }

    case 'INFO_PHONE': {
      await updateSession(lineUserId, { temp_phone: text, state: 'INFO_SYMPTOM' });
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '症状やご相談内容を教えてください',
      });
    }

    case 'INFO_SYMPTOM': {
      const updatedSession = { ...session, temp_symptom: text };
      await updateSession(lineUserId, { temp_symptom: text, state: 'DONE' });
      const reservation = await finalizeReservation(lineUserId, updatedSession);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          `ご予約を受け付けました。\n` +
          `${formatDatetime(reservation.scheduled_at)}　${reservation.department}\n` +
          `予約番号　${reservation.reservation_no}\n\n` +
          `当日はお気をつけてお越しください。`,
      });
    }

    default: {
      await resetSession(lineUserId);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ご希望の診療科を選んでください🍀',
        quickReply: buildQuickReply(DEPARTMENTS),
      });
    }
  }
}

function buildQuickReply(labels) {
  return {
    items: labels.slice(0, 13).map((label) => ({
      type: 'action',
      action: { type: 'message', label, text: label },
    })),
  };
}

function replyDatetimeOptions(replyToken) {
  const options = buildDatetimeOptions();
  return client.replyMessage(replyToken, {
    type: 'text',
    text: 'ご希望の日時を選んでください',
    quickReply: buildQuickReply(options.map((o) => o.label)),
  });
}

function formatDatetime(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`;
}

// ---- ルーティング ----
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

app.get('/', (req, res) => {
  res.send('CLIVA LINE webhook is running.');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Webhook server listening on port ${port}`);
});
