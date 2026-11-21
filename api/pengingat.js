// Endpoint pengingat (Vercel serverless):
//   GET  /api/pengingat?kunci                          -> VAPID public key untuk subscribe di browser
//   GET/POST dengan header Authorization: Bearer CRON_SECRET -> kirim pengingat yang jatuh tempo (dipanggil cron eksternal tiap 5-15 menit)
//   POST dengan header Authorization: Bearer <Firebase ID token> -> kirim notifikasi tes ke HP milik user itu
import { timingSafeEqual } from 'node:crypto';
import * as webpush from 'web-push';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { jatuhTempo } from './_jadwal.js';

const env = process.env;
let db;
function siap() {
  if (db) return;
  const app = getApps()[0] || initializeApp({ credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
  db = getFirestore(app);
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

const samaRahasia = s => {
  const a = Buffer.from(String(s)), b = Buffer.from(String(env.CRON_SECRET || ''));
  return b.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
};

// kirim ke semua HP user; langganan yang sudah tidak berlaku (404/410) dihapus
async function kirim(subs, pesan) {
  let ok = 0;
  await Promise.all(subs.map(d => webpush.sendNotification(d.get('sub'), JSON.stringify(pesan), { TTL: 1800, urgency: 'high' })
    .then(() => ok++)
    .catch(e => [404, 410].includes(e.statusCode) ? d.ref.delete() : console.error('push gagal', e.statusCode, e.body))));
  return ok;
}

export default async function handler(req, res) {
  if (req.method === 'GET' && 'kunci' in req.query) return res.json({ publicKey: env.VAPID_PUBLIC_KEY });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'butuh Authorization' });
  siap();

  if (samaRahasia(token)) {
    const now = Date.now(), perUser = {};
    (await db.collectionGroup('push').get()).forEach(d => {
      const uid = d.ref.parent.parent?.id;
      if (uid) (perUser[uid] ||= []).push(d);
    });
    let terkirim = 0;
    for (const [uid, subs] of Object.entries(perUser)) {
      const ref = db.doc(`users/${uid}`), data = (await ref.get()).data() || {};
      if (!data.caregiver) continue;
      const due = jatuhTempo(data.caregiver, now, data.cgTerkirim);
      if (!due.length) continue;
      for (const p of due) terkirim += await kirim(subs, { title: p.judul, body: p.isi, tag: p.id });
      await ref.set({ cgTerkirim: Object.fromEntries(due.map(p => [p.id, p.t])) }, { merge: true });
    }
    return res.json({ user: Object.keys(perUser).length, terkirim });
  }

  if (req.method !== 'POST') return res.status(405).end();
  let uid;
  try { uid = (await getAuth().verifyIdToken(token)).uid; } catch (e) { return res.status(401).json({ error: 'token tidak valid' }); }
  const subs = (await db.collection(`users/${uid}/push`).get()).docs;
  const ok = await kirim(subs, { title: 'Tes pengingat', body: 'Notifikasi Saku Bidan sudah jalan di HP ini.', tag: 'tes' });
  res.json({ hp: subs.length, terkirim: ok });
}
