// AçıklandıMı - Malatya Adliyesi Duyuru & İKM Sonuç Takip Botu (GitHub Actions)
// Yeni duyuru eklenince ve İKM mülakat sonucu açıklanınca Telegram'a bildirim atar.

const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://malatya.adalet.gov.tr/Arsiv/duyuru';
const SITE_URL = 'http://aciklandinmi.gt.tc';
const STATE_FILE = path.join(__dirname, 'seen.json');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
let CHAT_IDS = [...ADMIN_IDS];
const SEND_TEST_MSG = process.env.SEND_TEST_MSG === 'true';

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

function cleanDisplayUrl(url) {
    return url.split(/\s+/)[0];
}

function isIkmResult(title) {
    const t = normalizeTr(title);
    const isIkm = t.includes('infaz ve koruma') || t.includes('infaz koruma') || t.includes('ikm') || (t.includes('infaz') && t.includes('memur'));
    if (!isIkm) return false;
    const isResult = ['sonuc', 'nihai', 'yerlestirme', 'mulakat', 'sozlu sinav', 'kazanan', 'basari'].some(k => t.includes(k));
    const isOldSchedule = ['tarihlerini gosterir', 'aday tespit', 'boy kilo'].some(k => t.includes(k));
    return isResult && !isOldSchedule;
}

async function sendTo(chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    return res.json();
}

// Bota /start yazanlari abone yapar, /stop yazanlari cikarir
async function processSubscriptions(state) {
    const prevSubs = state.subscribers || [];
    const subs = new Set(prevSubs);
    const prevOffset = state.update_offset || 0;
    let changed = false;

    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${prevOffset}&timeout=0`);
    const data = await res.json();
    if (!data.ok) {
        console.error('getUpdates hatasi:', data.description);
        return { subs, changed: false };
    }
    for (const u of data.result) {
        state.update_offset = u.update_id + 1;
        changed = true;
        const msg = u.message;
        if (!msg || !msg.text) continue;
        const id = String(msg.chat.id);
        const cmd = msg.text.trim().toLowerCase();
        if (cmd.startsWith('/start')) {
            subs.add(id);
            await sendTo(id, `✅ <b>Abone oldunuz!</b>\n\nMalatya Adliyesi'ne yeni duyuru eklendiğinde ve 🚨 İKM mülakat sonuçları açıklandığında size buradan haber vereceğim.\n\nBildirimleri durdurmak için /stop yazın.\n\n🌐 Site: ${SITE_URL}`);
        } else if (cmd.startsWith('/stop')) {
            subs.delete(id);
            await sendTo(id, `🔕 Aboneliğiniz iptal edildi. Tekrar başlamak için /start yazın.`);
        }
    }
    return { subs, changed };
}

async function sendTelegram(text) {
    let allOk = true;
    for (const chatId of CHAT_IDS) {
        const data = await sendTo(chatId, text);
        if (!data.ok) { console.error('Telegram hatası (' + chatId + '):', data.description); allOk = false; }
    }
    return allOk;
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
    if (!TOKEN || ADMIN_IDS.length === 0) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secret eksik!');

    let state = { seen: [], initialized: false };
    if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    const wasInitialized = Boolean(state.initialized);
    const { subs, changed: subsChanged } = await processSubscriptions(state);
    if (subs.size > 0 || state.subscribers) {
        state.subscribers = [...subs];
    }
    CHAT_IDS = [...new Set([...ADMIN_IDS, ...subs])];
    const saveState = () => {
        delete state.last_check;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
    };
    const sendAdmin = async (text) => { for (const id of ADMIN_IDS) await sendTo(id, text); };

    let items;
    try {
        items = await fetchAnnouncements();
    } catch (e) {
        console.error('Adliye sitesine erişilemedi:', e.message);
        if (SEND_TEST_MSG) await sendAdmin(`⚠️ <b>Test çalıştırması:</b> Malatya Adliyesi sitesine erişilemedi.\nHata: ${escapeHtml(e.message)}`);
        if (subsChanged) saveState();
        process.exit(1);
    }

    const seen = new Set(state.seen);
    const newItems = items.filter(i => !seen.has(i.url));

    if (!wasInitialized) {
        await sendTelegram(
            `✅ <b>AçıklandıMı takip botu 7/24 aktif!</b>\n\n` +
            `Malatya Adliyesi duyuruları her 5 dakikada bir kontrol ediliyor (${items.length} duyuru kaydedildi).\n\n` +
            `📢 Yeni duyuru eklenince ve 🚨 İKM mülakat sonuçları açıklanınca buraya mesaj gelecek.\n\n` +
            `🌐 Site: ${SITE_URL}`
        );
    } else {
        for (const item of newItems.reverse()) {
            const link = cleanDisplayUrl(item.url);
            let msg;
            if (isIkmResult(item.title)) {
                msg = `🚨🚨 <b>MÜJDE! İKM MÜLAKAT SONUÇLARI AÇIKLANDI!</b> 🚨🚨\n\n` +
                      `📢 <b>${escapeHtml(item.title)}</b>\n📅 ${item.date}\n\n` +
                      `📄 Resmi ilan: ${link}\n\n🌐 Site: ${SITE_URL}`;
            } else {
                msg = `📢 <b>Malatya Adliyesi'nde yeni duyuru</b>\n\n` +
                      `${escapeHtml(item.title)}\n📅 ${item.date}\n\n` +
                      `📄 İlan: ${link}\n\n🌐 Site: ${SITE_URL}`;
            }
            await sendTelegram(msg);
        }
        if (SEND_TEST_MSG && newItems.length === 0) {
            await sendAdmin(`🔎 <b>Test çalıştırması başarılı.</b>\nYeni duyuru yok, İKM sonucu henüz açıklanmadı. Takip devam ediyor.\n👥 Abone sayısı: ${CHAT_IDS.length}\n\n🌐 Site: ${SITE_URL}`);
        }
    }

    // Sadece yeni duyuru varsa, ilk çalıştırmaysa veya abone listesi değiştiyse seen.json'ı kaydet
    if (!wasInitialized || newItems.length > 0 || subsChanged) {
        items.forEach(i => seen.add(i.url));
        state.initialized = true;
        state.seen = [...seen].slice(-500);
        saveState();
        console.log(`Durum güncellendi: ${items.length} duyuru, ${newItems.length} yeni.`);
    } else {
        console.log(`Kontrol tamam (değişiklik yok): ${items.length} duyuru, 0 yeni.`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
