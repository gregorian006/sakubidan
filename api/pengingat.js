// Endpoint pengingat (Vercel serverless):
//   GET  /api/pengingat?kunci                          -> VAPID public key untuk subscribe di browser
//   GET/POST dengan header Authorization: Bearer CRON_SECRET -> kirim pengingat yang jatuh tempo (dipanggil cron eksternal tiap 5-15 menit)
//   POST dengan header Authorization: Bearer <Firebase ID token> -> kirim notifikasi tes ke HP milik user itu
import { timingSafeEqual } from 'node:crypto';
import { jatuhTempo } from './_jadwal.js';

const env = process.env;
// library berat dimuat saat dibutuhkan saja: ?kunci tetap jalan, dan kalau setup salah pesannya jelas (bukan crash)
let db, webpush;
async function siap() {
  if (db) return;
  const [fApp, fStore, wp] = await Promise.all([import('firebase-admin/app'), import('firebase-admin/firestore'), import('web-push')]);
  const kurang = ['FIREBASE_SERVICE_ACCOUNT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'CRON_SECRET'].filter(k => !env[k]);
  if (kurang.length) throw new Error('env Vercel belum diisi: ' + kurang.join(', '));
  const app = fApp.getApps()[0] || fApp.initializeApp({ credential: fApp.cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
  wp.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  webpush = wp; db = fStore.getFirestore(app);
}

// cek Firebase ID token lewat Google Identity Toolkit (token diverifikasi di server Google).
// Bukan firebase-admin/auth: dependensinya (jwks-rsa -> jose) gagal dimuat di runtime Node Vercel.
// API key ini memang publik (sama dengan yang ada di index.html).
const FIREBASE_API_KEY = 'AIzaSyCk401IqoWD7WpUS6ZwHSp-3XsOPRrxbK4';
async function uidDariToken(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }),
  });
  return r.ok ? (await r.json()).users?.[0]?.localId : null;
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
  try { await siap(); } catch (e) { console.error(e); return res.status(500).json({ error: 'server belum siap: ' + e.message }); }

  if (samaRahasia(token)) {
    const now = Date.now(), perUser = {};
    (await db.collectionGroup('push').get()).forEach(d => {
      const uid = d.ref.parent.parent?.id;
      if (uid) (perUser[uid] ||= []).push(d);
    });
    let terkirim = 0;
    for (const [uid, subs] of Object.entries(perUser)) {
      try { // data satu user yang rusak (mis. zona waktu tidak dikenal) tidak boleh menghentikan pengingat user lain
        const ref = db.doc(`users/${uid}`), data = (await ref.get()).data() || {};
        if (!data.caregiver) continue;
        const due = jatuhTempo(data.caregiver, now, data.cgTerkirim);
        if (!due.length) continue;
        for (const p of due) terkirim += await kirim(subs, { title: p.judul, body: p.isi, tag: p.id });
        await ref.set({ cgTerkirim: Object.fromEntries(due.map(p => [p.id, p.t])) }, { merge: true });
      } catch (e) { console.error('pengingat gagal untuk', uid, e); }
    }
    return res.json({ user: Object.keys(perUser).length, terkirim });
  }

  if (req.method !== 'POST') return res.status(405).end();
  let uid;
  try { uid = await uidDariToken(token); } catch (e) { console.error(e); }
  if (!uid) return res.status(401).json({ error: 'token tidak valid' });
  const subs = (await db.collection(`users/${uid}/push`).get()).docs;
  const ok = await kirim(subs, { title: 'Tes pengingat', body: 'Notifikasi Saku Bidan sudah jalan di HP ini.', tag: 'tes' });
  res.json({ hp: subs.length, terkirim: ok });
}
