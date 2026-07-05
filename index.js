// CLIVA予約システム Webhookサーバー
// 患者からのLINEメッセージを受け取り、日時選択(カード型)→氏名/電話/症状入力→予約確定
// の順に会話を進め、Supabase(PostgreSQL)に保存します。
//
// 診療科の選択ステップは廃止しました。予約データ上は department を空欄のまま保存し、
// 受診科はスタッフが後から電話・問診等で確認して入力する運用を前提としています。

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
const TIME_SLOTS = ['10:00', '14:00', '15:30', '17:00'];

// ---- 日付候補（今日・明日・明後日） ----
function buildDateOptions() {
  const dayLabels = ['今日', '明日', '明後日'];
  return [0, 1, 2].map((offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    const label = `${dayLabels[offset]}　${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_JA[d.getDay()]})`;
    return { label, iso: d.toISOString().slice(0, 10) }; // YYYY-MM-DD
  });
}

// ---- 指定日付に対する時間候補 ----
function buildTimeOptionsForDate(dateIso) {
  return TIME_SLOTS.map((t) => {
    const [h, m] = t.split(':').map(Number);
    const dt = new Date(`${dateIso}T00:00:00`);
    dt.setHours(h, m, 0, 0);
    return { label: t, iso: dt.toISOString() };
  });
}

// ---- Flex Message: カード型の選択肢を1枚のバブルにまとめる ----
// options: [{ label, data, displayText }]
function buildCardSelectFlex({ altText, heading, subheading, options, footerOptions = [] }) {
  const optionBox = (opt, accentBorder = false) => ({
    type: 'box',
    layout: 'vertical',
    cornerRadius: '12px',
    borderWidth: accentBorder ? '2px' : '1px',
    borderColor: COLORS.cardBorder,
    backgroundColor: COLORS.cardBg,
    paddingAll: '18px',
    margin: 'md',
    action: {
      type: 'postback',
      data: opt.data,
      displayText: opt.displayText || opt.label,
    },
    contents: [
      {
        type: 'text',
        text: opt.label,
        size: 'xl',
        weight: 'bold',
        align: 'center',
        wrap: true,
        color: COLORS.titleText,
      },
    ],
  });

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
function sendDateCards(replyToken) {
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
  return client.replyMessage(replyToken, flex);
}

// ---- 時間選択カードを送信（「日付選びなおし」の戻るカード付き） ----
function sendTimeCards(replyToken, dateIso, dateLabel) {
  const timeOptions = buildTimeOptionsForDate(dateIso);
  const flex = buildCardSelectFlex({
    altText: 'ご希望の時間を選んでください',
    heading: 'ご希望の時間を選んでください',
    subheading: `${dateLabel} のご希望時間`,
    options: timeOptions.map((t) => ({
      label: t.label,
      data: `action=selectTime&value=${t.iso}`,
      displayText: t.label,
    })),
    footerOptions: [
      {
        label: '← 日付を選びなおす',
        data: 'action=backToDate',
        displayText: '日付を選びなおす',
      },
    ],
  });
  return client.replyMessage(replyToken, flex);
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
    .insert({ line_user_id: lineUserId, state: 'DATE' })
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
      state: 'DATE',
      temp_date: null,
      temp_datetime: null,
      temp_name: null,
      temp_phone: null,
      temp_symptom: null,
      updated_at: new Date().toISOString(),
    })
    .eq('line_user_id', lineUserId);
}

// ---- 予約確定処理 ----
// department は空欄（null）で保存し、受診科はスタッフが後から確認・入力する。
async function finalizeReservation(lineUserId, session) {
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

  const { data: reservationNo, error: noError } = await supabase.rpc('next_reservation_no');
  const finalReservationNo = noError || !reservationNo ? `A-${Math.floor(1000 + Math.random() * 9000)}` : reservationNo;

  const { data: reservation } = await supabase
    .from('reservations')
    .insert({
      patient_id: patient.id,
      department: null, // 受診科は未確定。スタッフが後から確認・入力する
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

// ---- テキストメッセージのハンドラ（氏名・電話・症状入力ステップ） ----
async function handleTextMessage(event) {
  const lineUserId = event.source.userId;
  const text = event.message.text.trim();
  const session = await getSession(lineUserId);

  // 「予約」等のキーワードでいつでもリセットして最初から
  if (text.includes('予約') && session.state !== 'DATE') {
    await resetSession(lineUserId);
    return sendDateCards(event.replyToken);
  }

  switch (session.state) {
    case 'DATE':
    case 'TIME':
      // 日時選択中はカードのタップ（postback）を待つ。テキストが来たら案内し直す。
      return sendDateCards(event.replyToken);

    case 'INFO_NAME': {
      await updateSession(lineUserId, { temp_name: text, state: 'INFO_PHONE' });
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'お名前を確認しました。\nお電話番号を教えてください（例：090-1234-5678）',
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
          `${formatDatetime(reservation.scheduled_at)}\n` +
          `予約番号　${reservation.reservation_no}\n\n` +
          `受診科につきましては、追ってスタッフよりご連絡いたします。\n` +
          `当日はお気をつけてお越しください。`,
      });
    }

    default: {
      await resetSession(lineUserId);
      return sendDateCards(event.replyToken);
    }
  }
}

// ---- ポストバックのハンドラ（日付・時間カードのタップ） ----
async function handlePostback(event) {
  const lineUserId = event.source.userId;
  const session = await getSession(lineUserId);
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');

  if (action === 'selectDate') {
    const dateIso = params.get('value');
    const dateOptions = buildDateOptions();
    const matched = dateOptions.find((d) => d.iso === dateIso);
    const dateLabel = matched ? matched.label : dateIso;
    await updateSession(lineUserId, { temp_date: dateIso, state: 'TIME' });
    return sendTimeCards(event.replyToken, dateIso, dateLabel);
  }

  if (action === 'selectTime') {
    const datetimeIso = params.get('value');
    await updateSession(lineUserId, { temp_datetime: datetimeIso, state: 'INFO_NAME' });
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'お名前を教えてください（例：山田 花子）',
    });
  }

  if (action === 'backToDate') {
    await updateSession(lineUserId, { temp_date: null, state: 'DATE' });
    return sendDateCards(event.replyToken);
  }

  // 想定外のpostbackは最初から案内し直す
  await resetSession(lineUserId);
  return sendDateCards(event.replyToken);
}

// ---- LINEイベントハンドラ ----
async function handleEvent(event) {
  if (event.type === 'message' && event.message.type === 'text') {
    return handleTextMessage(event);
  }
  if (event.type === 'postback') {
    return handlePostback(event);
  }
  return Promise.resolve(null);
}

function formatDatetime(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_JA[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(
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
