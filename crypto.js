// ============================================================
// CLIVA マルチクリニックSaaS化 Phase 2
// 医院ごとの認証情報（LINEチャネルシークレット等）を暗号化・復号するユーティリティ
//
// アルゴリズム: AES-256-GCM（改ざん検知つきの認証付き暗号）
// マスターキー: 環境変数 CLIVA_MASTER_KEY（32バイトを16進数64文字で指定）
//   - ローカルの .env と、Renderの環境変数の両方に同じ値を設定してください
//   - 生成方法は generate_master_key.js を参照
// ============================================================

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCMではIVは12バイト推奨

function getMasterKey() {
  const hex = process.env.CLIVA_MASTER_KEY;
  if (!hex) {
    throw new Error('環境変数 CLIVA_MASTER_KEY が設定されていません');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('CLIVA_MASTER_KEY は32バイト（16進数64文字）である必要があります。generate_master_key.js で生成してください');
  }
  return key;
}

/**
 * 平文を暗号化し、DBの1カラムにそのまま保存できる文字列を返す
 * 形式: base64(iv) + ':' + base64(authTag) + ':' + base64(暗号文)
 * @param {string|null|undefined} plainText
 * @returns {string|null} 空文字・null・undefinedの場合はnullを返す（未設定を表現）
 */
function encryptSecret(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') {
    return null;
  }
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

/**
 * encryptSecret() で暗号化した文字列を復号して平文に戻す
 * @param {string|null|undefined} encryptedText
 * @returns {string|null}
 */
function decryptSecret(encryptedText) {
  if (!encryptedText) {
    return null;
  }
  const key = getMasterKey();
  const parts = String(encryptedText).split(':');
  if (parts.length !== 3) {
    throw new Error('暗号化データの形式が不正です（iv:authTag:暗号文の3分割になっていません）');
  }
  const [ivB64, authTagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
