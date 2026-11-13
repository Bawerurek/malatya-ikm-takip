// AçıklandıMı - Malatya Adliyesi Duyuru & İKM Sonuç Takip Botu (GitHub Actions)
// Yeni duyuru eklenince ve İKM mülakat sonucu açıklanınca Telegram'a bildirim atar.

const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://malatya.adalet.gov.tr/Arsiv/duyuru';
const SITE_URL = 'http://aciklandinmi.gt.tc';
const STATE_FILE = path.join(__dirname, 'seen.json');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MANUAL = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

function normalizeTr(str) {
    const map = { 'İ': 'i', 'I': 'i', 'ı': 'i', 'ö': 'o', 'Ö': 'o', 'ü': 'u', 'Ü': 'u', 'ş': 's', 'Ş': 's', 'ç': 'c', 'Ç': 'c', 'ğ': 'g', 'Ğ': 'g' };
    return str.replace(/[İIıöÖüÜşŞçÇğĞ]/g, c => map[c]).toLowerCase();
}

function decodeEntities(s) {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(d))
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isIkmResult(title) {
    const t = normalizeTr(title);
    const isIkm = t.includes('infaz ve koruma') || t.includes('infaz koruma') || t.includes('ikm') || (t.includes('infaz') && t.includes('memur'));
    if (!isIkm) return false;
    const isResult = ['sonuc', 'nihai', 'yerlestirme', 'mulakat', 'sozlu sinav', 'kazanan', 'basari'].some(k => t.includes(k));
    const isOldSchedule = ['tarihlerini gosterir', 'aday tespit', 'boy kilo'].some(k => t.includes(k));
    return isResult && !isOldSchedule;
}

async function sendTelegram(text) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram hatası:', data.description);
    return data.ok;
}

async function fetchAnnouncements() {
    const res = await fetch(TARGET_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const regex = /<a\s+href=([^>]+)>\s*<span>([^<]*)<\/span>\s*<div\s+class=baslik>([^<]*)<\/div>/gi;
    const items = [];
    let m;
    while ((m = regex.exec(html)) !== null) {
        let url = m[1].replace(/['"]/g, '').trim();
        if (!url.startsWith('http')) url = 'https://malatya.adalet.gov.tr' + (url.startsWith('/') ? '' : '/') + url;
        items.push({ url, date: m[2].trim(), title: decodeEntities(m[3].trim()) });
    }
    if (items.length === 0) throw new Error('Sayfada duyuru bulunamadı (site yapısı değişmiş olabilir)');
    return items;
}

async function main() {
    if (!TOKEN || !CHAT_ID) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secret eksik!');

    let state = { seen: [], initialized: false };
    if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    let items;
    try {
        items = await fetchAnnouncements();
    } catch (e) {
        console.error('Adliye sitesine erişilemedi:', e.message);
        if (MANUAL) await sendTelegram(`⚠️ <b>Test çalıştırması:</b> Malatya Adliyesi sitesine erişilemedi.\nHata: ${escapeHtml(e.message)}`);
        process.exit(1);
    }

    const seen = new Set(state.seen);
    const newItems = items.filter(i => !seen.has(i.url));

    if (!state.initialized) {
        // İlk çalıştırma: mevcut duyuruları kaydet, eski duyurular için bildirim atma
        await sendTelegram(
            `✅ <b>AçıklandıMı takip botu 7/24 aktif!</b>\n\n` +
            `Malatya Adliyesi duyuruları her 5 dakikada bir kontrol ediliyor (${items.length} duyuru kaydedildi).\n\n` +
            `📢 Yeni duyuru eklenince ve 🚨 İKM mülakat sonuçları açıklanınca buraya mesaj gelecek.\n\n` +
            `🌐 Site: ${SITE_URL}`
        );
    } else {
        for (const item of newItems.reverse()) {
            let msg;
            if (isIkmResult(item.title)) {
                msg = `🚨🚨 <b>MÜJDE! İKM MÜLAKAT SONUÇLARI AÇIKLANDI!</b> 🚨🚨\n\n` +
                      `📢 <b>${escapeHtml(item.title)}</b>\n📅 ${item.date}\n\n` +
                      `📄 Resmi ilan: ${item.url}\n\n🌐 Site: ${SITE_URL}`;
            } else {
                msg = `📢 <b>Malatya Adliyesi'nde yeni duyuru</b>\n\n` +
                      `${escapeHtml(item.title)}\n📅 ${item.date}\n\n` +
                      `📄 İlan: ${item.url}\n\n🌐 Site: ${SITE_URL}`;
            }
            await sendTelegram(msg);
        }
        if (MANUAL && newItems.length === 0) {
            await sendTelegram(`🔎 <b>Test çalıştırması başarılı.</b>\nYeni duyuru yok, İKM sonucu henüz açıklanmadı. Takip devam ediyor.\n\n🌐 Site: ${SITE_URL}`);
        }
    }

    items.forEach(i => seen.add(i.url));
    state = { initialized: true, seen: [...seen].slice(-500), last_check: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`Kontrol tamam. ${items.length} duyuru, ${newItems.length} yeni.`);
}

main().catch(e => { console.error(e); process.exit(1); });
