require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- ক্র্যাশ প্রোটেকশন ---
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err.message); });

// --- Express Server (For Webhook & Keep-Alive) ---
const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL; 

app.use(express.json());
app.get('/', (req, res) => res.send('Premium Fire OTP Bot - VX TEAM Edition V35 (ForceSub Fully Fixed) Running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- MongoDB Setup ---
const MONGO_URI = process.env.MONGO_URI || "YOUR_MONGODB_URI_HERE";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- Mongoose Schemas ---
const UserSchema = new mongoose.Schema({
    id: String,
    first_name: String,
    username: String,
    total_numbers: { type: Number, default: 0 },
    total_otps: { type: Number, default: 0 },
    today_otps: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    today_balance: { type: Number, default: 0 },
    sub_admin_balance: { type: Number, default: 0 }, 
    last_active_date: String,
    banned: { type: Boolean, default: false },
    joined: String,
    referred_by: { type: String, default: null },
    referral_count: { type: Number, default: 0 },
    referral_earnings: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

const SettingSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    data: mongoose.Schema.Types.Mixed
});
const Setting = mongoose.model('Setting', SettingSchema);

const EarningSchema = new mongoose.Schema({
    user_id: String,
    num_id: String,
    date: String
});
const Earning = mongoose.model('Earning', EarningSchema);

const WithdrawSchema = new mongoose.Schema({
    wd_id: String,
    user_id: String,
    amount: Number,
    method: String,
    account: String,
    status: { type: String, default: 'pending' }, 
    is_sub_admin: { type: Boolean, default: false },
    date: String
});
const Withdraw = mongoose.model('Withdraw', WithdrawSchema);

// --- কনফিগারেশন ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MAIN_ADMIN_ID = String(process.env.MAIN_ADMIN_ID || "").trim();
const SUB_ADMIN_ID = String(process.env.SUB_ADMIN_ID || "").trim();
const NUMBER_EXPIRY_MS = 15 * 60 * 1000; 
const BASE_OTP_REVENUE = 0.40; 

function isAdmin(id) { return String(id) === MAIN_ADMIN_ID || String(id) === SUB_ADMIN_ID; }
function isMainAdmin(id) { return String(id) === MAIN_ADMIN_ID; }

// Markdown Error Prevention
function safeMD(text) { return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }

let bot;
if (SERVER_URL) {
    bot = new TelegramBot(BOT_TOKEN);
    bot.setWebHook(`${SERVER_URL}/bot${BOT_TOKEN}`);
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
} else {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    bot.on('polling_error', (err) => console.log("Polling Error:", err.message));
}

let botUsername = "";
bot.getMe().then(me => { botUsername = me.username; }).catch(()=>{});

let adminState = {};
let userState = {};

// ==========================================
// 🔥 DUAL PANEL API SETUP
// ==========================================
const PANELS = {
    stexsms: { baseUrl: 'https://api.2oo9.cloud/MXS47FLFX0U/tness/@public/api' },
    voltxsms: { baseUrl: 'https://api.2oo9.cloud/MXS47FLFX0U/tnevs/@public/api' }
};

let panelKeys = { 
    stexsms: process.env.STEXSMS_API || "MKMGV6W3B12", 
    voltxsms: process.env.VOLTXSMS_API || "MW52YD6690X" 
}; 

async function loadPanelKeys() {
    try {
        const doc = await Setting.findOne({ key: 'panel_keys' });
        if (doc && doc.data) {
            if(doc.data.stexsms) panelKeys.stexsms = doc.data.stexsms;
            if(doc.data.voltxsms) panelKeys.voltxsms = doc.data.voltxsms;
        }
    } catch(e) {}
}

async function panelRequest(method, endpoint, data = null, panelName = 'stexsms') {
    const key = panelKeys[panelName];
    if (!key) throw new Error(`NO_API_KEY_${panelName}`);
    
    const headers = { 'mauthapi': key.trim(), 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };
    const url = `${PANELS[panelName].baseUrl}${endpoint}`;
    
    try {
        if(method === 'post') return await axios.post(url, data, { headers, timeout: 15000 });
        else return await axios.get(url, { headers, timeout: 15000 });
    } catch (e) { throw e; }
}

// ==========================================
// 🚀 CONFIG & STATE MANAGERS 
// ==========================================
const activeNumbers = new Map(); 
const deliveredOtps = new Set();
const seenConsoleHits = new Set();
const userLastSession = new Map(); 

function getBdDateStr() {
    const now = new Date();
    const bdTimeMs = now.getTime() + (now.getTimezoneOffset() * 60000) + (6 * 3600000);
    return new Date(bdTimeMs).toISOString().split('T')[0];
}
function getLocDate() { return new Date().toISOString(); }

setInterval(() => {
    const now = Date.now();
    for (let [number, data] of activeNumbers.entries()) {
        if (now - data.createdAt > NUMBER_EXPIRY_MS) {
            activeNumbers.delete(number);
            updateGlobalStats('failed');
        }
    }
}, 60000);

async function getAppConfig() {
    try {
        let doc = await Setting.findOne({ key: 'app_config' });
        let config = doc && doc.data ? doc.data : {};
        if (config.per_otp_rate === undefined) config.per_otp_rate = 0.20;
        if (config.min_withdraw === undefined) config.min_withdraw = 50;
        if (config.pay_methods === undefined) config.pay_methods = ['Binance', 'Bkash', 'Nagad'];
        if (config.reward_system === undefined) config.reward_system = true;
        if (config.top_reward_on === undefined) config.top_reward_on = true; 
        if (config.stexsms_on === undefined) config.stexsms_on = true;     
        if (config.voltxsms_on === undefined) config.voltxsms_on = true;   
        if (config.force_start === undefined) config.force_start = false;  
        if (config.global_feed_on === undefined) config.global_feed_on = true; 
        if (config.ref_otp_commission === undefined) config.ref_otp_commission = 0.05; 
        if (config.bonus_top1 === undefined) config.bonus_top1 = 50;
        if (config.bonus_top2 === undefined) config.bonus_top2 = 30;
        if (config.bonus_top3 === undefined) config.bonus_top3 = 20;
        if (config.otp_group === undefined) config.otp_group = "@otp_number_grp";
        if (config.payment_group === undefined) config.payment_group = "-1003925192534";
        if (!Array.isArray(config.force_channels)) config.force_channels = []; 
        if (config.support_user === undefined) config.support_user = "developer_walid";
        return config;
    } catch(e) { 
        return { per_otp_rate: 0.20, min_withdraw: 50, pay_methods: ['Binance', 'Bkash', 'Nagad'], reward_system: true, top_reward_on: true, stexsms_on: true, voltxsms_on: true, force_start: false, global_feed_on: true, ref_otp_commission: 0.05, bonus_top1: 50, bonus_top2: 30, bonus_top3: 20, otp_group: "@otp_number_grp", payment_group: "-1003925192534", force_channels: [], support_user: "developer_walid" }; 
    }
}
async function saveAppConfig(data) { await Setting.findOneAndUpdate({ key: 'app_config' }, { data }, { upsert: true }); }

async function ensureUser(user) {
    if (!user || !user.id) return null;
    try {
        const todayStr = getBdDateStr();
        let u = await User.findOne({ id: String(user.id) });
        if (!u) {
            u = new User({ id: String(user.id), first_name: user.first_name || 'User', username: user.username || 'N/A', joined: new Date().toISOString(), last_active_date: todayStr });
            await u.save();
        } else {
            if (u.last_active_date !== todayStr) { 
                u.today_otps = 0; u.today_balance = 0; u.last_active_date = todayStr; await u.save(); 
            }
        }
        return u;
    } catch(e) { return null; }
}

async function updateGlobalStats(type) {
    try {
        let update = {};
        if (type === 'pending') update = { 'data.pending': 1 };
        if (type === 'success') { update = { 'data.success': 1, 'data.pending': -1 }; }
        if (type === 'failed') { update = { 'data.failed': 1, 'data.pending': -1 }; }
        await Setting.findOneAndUpdate({ key: 'global_stats' }, { $inc: update }, { upsert: true });
    } catch(e){}
}

async function loadRanges() {
    try { const doc = await Setting.findOne({ key: 'platforms' }); return doc && doc.data ? doc.data : {}; } catch(e){ return {}; }
}
async function saveRanges(data) {
    try { await Setting.findOneAndUpdate({ key: 'platforms' }, { data }, { upsert: true }); } catch(e){}
}
async function updateTraffic(plat, country) {
    try {
        const trafficKey = `${getPlatIcon(plat)} ${plat.toUpperCase()} - ${country.split(' ')[0]}`;
        const updateStr = `data.${trafficKey}`;
        await Setting.findOneAndUpdate({ key: 'traffic' }, { $inc: { [updateStr]: 1 } }, { upsert: true });
    } catch(e){}
}

function getPlatIcon(plat) {
    let p = plat.toLowerCase();
    if(p.includes('insta')) return '📷';
    if(p.includes('face')) return '🔵';
    if(p.includes('whats')) return '🟢';
    if(p.includes('tele')) return '✈️';
    if(p.includes('goog')) return '🔴';
    return '💬';
}

function getCountryByCode(range) {
    if (!range) return "Global";
    const cleanRange = String(range).replace('+', '');
    const codeMap = {
        '224': '🇬🇳 Guinea', '229': '🇧🇯 Benin', '225': '🇨🇮 Ivory Coast', '234': '🇳🇬 Nigeria',
        '237': '🇨🇲 Cameroon', '221': '🇸🇳 Senegal', '228': '🇹🇬 Togo', '223': '🇲🇱 Mali',
        '226': '🇧🇫 Burkina Faso', '243': '🇨🇩 DR Congo', '242': '🇨🇬 Congo', '227': '🇳🇪 Niger',
        '212': '🇲🇦 Morocco', '254': '🇰🇪 Kenya', '233': '🇬🇭 Ghana', '20':  '🇪🇬 Egypt',
        '27':  '🇿🇦 South Africa', '880': '🇧🇩 Bangladesh', '91':  '🇮🇳 India', '92':  '🇵🇰 Pakistan',
        '44':  '🇬🇧 UK', '1':   '🇺🇸 USA/Canada'
    };
    const prefixes = Object.keys(codeMap).sort((a, b) => b.length - a.length);
    for (let p of prefixes) { if (cleanRange.startsWith(p)) return codeMap[p]; }
    return "Global";
}

function getMainMenu(chatId) {
    let kb = [
        [{ text: "📡 LIVE RANGE", style: "danger" }, { text: "📱 GET NUMBER", style: "primary" }], 
        [{ text: "👤 ACCOUNT", style: "success" }, { text: "🎁 Referrals", style: "danger" }],
        [{ text: "🏆 Top Users", style: "success" }, { text: "🎧 SUPPORT", style: "primary" }]
    ];
    if (isAdmin(chatId)) kb.push([{ text: "🛠️ ADMIN PANEL", style: "danger" }]);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

function getAdminMenu(chatId) {
    let kb = [
        [{ text: "📊 Dashboard", callback_data: "adm_dash", style: "danger" }, { text: "👥 Manage Users", callback_data: "adm_users", style: "success" }],
        [{ text: "🌐 Manage Sites", callback_data: "adm_sites", style: "success" }, { text: "⚙️ Manage Ranges", callback_data: "adm_ranges", style: "danger" }],
        [{ text: "📢 Broadcast", callback_data: "adm_broadcast", style: "primary" }, { text: "💳 Payment Settings", callback_data: "adm_paycfg", style: "primary" }]
    ];
    if (String(chatId) === SUB_ADMIN_ID) { kb.push([{ text: "💰 Sub Admin Balance", callback_data: "adm_sub_balance", style: "danger" }]); }
    if (isMainAdmin(chatId)) {
        kb.push([{ text: "🔗 Manage Groups & Channels", callback_data: "adm_groups", style: "success" }, { text: "⚙️ Bot Settings", callback_data: "adm_bot_settings", style: "primary" }]);
    }
    return { inline_keyboard: kb };
}

function extractOTP(msg) {
    if (!msg) return "Code Not Found";
    msg = String(msg).trim();
    if (/^\d{4,8}$/.test(msg)) return msg; 
    const match = msg.match(/(?:\d[\s-]*){4,8}/);
    if (match && match[0]) return match[0].replace(/\D/g, ''); 
    return msg; 
}

function detectLang(text) {
    if (!text) return 'English';
    if (/[\u0980-\u09FF]/.test(text)) return 'Bengali';
    if (/[\u0400-\u04FF]/.test(text)) return 'Russian';
    if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
    return 'English';
}

// 🟢 Subscription Checker Logic (Fixed missing link parser)
async function isUserSubscribed(chatId) {
    if (isAdmin(chatId)) return true;
    const config = await getAppConfig();
    const channels = Array.isArray(config.force_channels) ? config.force_channels : [];
    if (channels.length === 0) return true;

    for (let ch of channels) {
        if (!ch) continue;
        try {
            let target = ch;
            if(ch.includes('t.me/') && !ch.includes('t.me/+')) {
                target = '@' + ch.split('t.me/')[1].split('/')[0];
            }
            const member = await bot.getChatMember(target, chatId);
            if (member.status === 'left' || member.status === 'kicked') return false;
        } catch (e) { return false; }
    }
    return true;
}

async function checkForceSub(chatId) {
    if (isAdmin(chatId)) return true;
    const config = await getAppConfig();
    const channels = Array.isArray(config.force_channels) ? config.force_channels : [];
    if (channels.length === 0) return true;

    let isSubscribed = true;
    let buttons = [];

    for (let ch of channels) {
        if (!ch) continue;
        try {
            let target = ch;
            if(ch.includes('t.me/') && !ch.includes('t.me/+')) {
                target = '@' + ch.split('t.me/')[1].split('/')[0];
            }
            
            const member = await bot.getChatMember(target, chatId);
            if (member.status === 'left' || member.status === 'kicked') {
                isSubscribed = false;
                buttons.push([{ text: `📢 Join Channel`, url: ch.startsWith('http') ? ch : `https://t.me/${ch.replace('@', '')}`, style: "danger" }]);
            }
        } catch (e) {
            isSubscribed = false;
            buttons.push([{ text: `📢 Join Channel`, url: ch.startsWith('http') ? ch : `https://t.me/${ch.replace('@', '')}`, style: "danger" }]);
        }
    }

    if (!isSubscribed) {
        buttons.push([{ text: "✅ Joined (Check Again)", callback_data: "check_joined", style: "success" }]);
        bot.sendMessage(chatId, "⚠️ *বট ব্যবহার করতে নিচের চ্যানেলগুলোতে জয়েন করুন:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(e=>console.error("ForceSub Err:", e.message));
        return false;
    }
    return true;
}

// 🟢 Fast Number Generation
async function generateNewNumber(chatId, plat, country, panelNameInput = null, rangeValInput = null, msgIdToEdit = null) {
    const config = await getAppConfig();
    const ranges = await loadRanges(); 
    let rangeVal = rangeValInput;
    let panelName = panelNameInput;

    if (!rangeValInput || !panelNameInput) {
        const rangeData = ranges[plat]?.[country];
        if (!rangeData) {
            const errTxt = "❌ *Number Not Found!*\n\n_দুঃখিত, এই মুহূর্তে এই রেঞ্জে কোনো নাম্বার স্টকে নেই।_";
            if (msgIdToEdit) bot.editMessageText(errTxt, {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
            else bot.sendMessage(chatId, errTxt, {parse_mode: 'Markdown'});
            return;
        }
        rangeVal = typeof rangeData === 'string' ? rangeData : rangeData.range;
        panelName = typeof rangeData === 'string' ? 'stexsms' : (rangeData.panel || 'stexsms');
    }

    if (panelName === 'stexsms' && !config.stexsms_on) return;
    if (panelName === 'voltxsms' && !config.voltxsms_on) return;
    
    let cleanRange = rangeVal.trim().replace(/XXX/ig, '');

    try {
        const res = await panelRequest('post', '/getnum', { rid: cleanRange }, panelName);
        
        if (res.data && res.data.meta && res.data.meta.status === 'ok') {
            const fullPhone = res.data.data.full_number;
            const strippedPhone = fullPhone.replace('+', ''); 
            
            let sentMsg;
            const text = `📱 *Platform:* ${getPlatIcon(plat)} \`${safeMD(plat)}\`\n🌍 *Country:* \`${safeMD(country)}\`\n\n╔════════════════════╗\n║ 📱 \`Wait for auto OTP...\`\n╚════════════════════╝`;
            const actionMarkup = { 
                inline_keyboard: [
                    [{ text: `📱 ${fullPhone}`, copy_text: { text: fullPhone }, style: "success" }],
                    [{ text: "🔁 Change Number", callback_data: `change_${strippedPhone}`, style: "danger" }]
                ] 
            };

            if (msgIdToEdit) {
                await bot.editMessageText(text, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown', reply_markup: actionMarkup }).catch(()=>{});
                sentMsg = { message_id: msgIdToEdit };
            } else {
                sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: actionMarkup });
            }

            activeNumbers.set(strippedPhone, { chatId, plat, country, panel: panelName, range: cleanRange, createdAt: Date.now(), msgId: sentMsg.message_id });
            await User.findOneAndUpdate({ id: String(chatId) }, { $inc: { total_numbers: 1 } }).catch(()=>{});
            updateGlobalStats('pending');
            
        } else {
            const outTxt = "❌ *Number Not Found!*";
            if (msgIdToEdit) bot.editMessageText(outTxt, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{});
            else bot.sendMessage(chatId, outTxt, { parse_mode: 'Markdown' });
        }
    } catch (error) { 
        const errTxt = "⚠️ *সার্ভার সাময়িক ব্যস্ত আছে। একটু পর আবার চেষ্টা করুন।*";
        if (msgIdToEdit) bot.editMessageText(errTxt, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{}); 
        else bot.sendMessage(chatId, errTxt, { parse_mode: 'Markdown' });
    }
}

// ==========================================
// 🔄 BACKGROUND TASKS (1 SECOND POLLING)
// ==========================================
let isPollingOTP = false;
setInterval(async () => {
    if (activeNumbers.size === 0 || isPollingOTP) return;
    isPollingOTP = true;
    const config = await getAppConfig();
    const todayStr = getBdDateStr();
    
    for (const pName of ['stexsms', 'voltxsms']) {
        if (pName === 'stexsms' && !config.stexsms_on) continue;
        if (pName === 'voltxsms' && !config.voltxsms_on) continue;
        if (!panelKeys[pName]) continue;
        
        try {
            const res = await panelRequest('get', '/success-otp', null, pName);
            if (res.data && res.data.meta && res.data.meta.status === 'ok') {
                const otps = res.data.data.otps || [];
                
                for (let otpData of otps) {
                    const otpId = String(otpData.otp_id);
                    const number = otpData.number;
                    
                    if (deliveredOtps.has(otpId)) continue;
                    
                    if (activeNumbers.has(number)) {
                        const session = activeNumbers.get(number);
                        deliveredOtps.add(otpId);
                        userLastSession.set(session.chatId, { plat: session.plat, country: session.country, panel: session.panel, range: session.range });

                        const otpCode = extractOTP(otpData.message);
                        const detectedLang = detectLang(otpData.message);
                        let earningText = "";

                        if (config.reward_system !== false) {
                            let earnedAmount = config.per_otp_rate || 0.20;
                            await Earning.create({ num_id: otpId, user_id: String(session.chatId), date: todayStr });
                            
                            const uDoc = await User.findOne({ id: String(session.chatId) });
                            if(uDoc) {
                                if(uDoc.last_active_date !== todayStr) {
                                    uDoc.today_otps = 0; uDoc.today_balance = 0; uDoc.last_active_date = todayStr;
                                }

                                uDoc.balance = parseFloat((uDoc.balance + earnedAmount).toFixed(2));
                                uDoc.today_balance = parseFloat((uDoc.today_balance + earnedAmount).toFixed(2));
                                uDoc.total_otps += 1; uDoc.today_otps += 1;
                                
                                const refComm = config.ref_otp_commission || 0.05;
                                if (uDoc.referred_by && refComm > 0) {
                                    const refUser = await User.findOne({ id: uDoc.referred_by });
                                    if (refUser) {
                                        refUser.balance = parseFloat((refUser.balance + refComm).toFixed(2));
                                        refUser.today_balance = parseFloat((refUser.today_balance + refComm).toFixed(2));
                                        refUser.referral_earnings = parseFloat(((refUser.referral_earnings || 0) + refComm).toFixed(2));
                                        await refUser.save();
                                    }
                                }
                                await uDoc.save();
                                earningText = `\n\n🎉 *Congratulations!*\n💰 *Earned:* \`${parseFloat(earnedAmount.toFixed(2))}\` ৳\n💳 *Total Balance:* \`${parseFloat(uDoc.balance.toFixed(2))}\` ৳`;

                                let subAdminProfit = parseFloat((BASE_OTP_REVENUE - earnedAmount).toFixed(2));
                                if (subAdminProfit > 0 && SUB_ADMIN_ID) {
                                    const subAdminDoc = await User.findOne({ id: String(SUB_ADMIN_ID) });
                                    if (subAdminDoc) {
                                        subAdminDoc.sub_admin_balance = parseFloat(((subAdminDoc.sub_admin_balance || 0) + subAdminProfit).toFixed(2));
                                        await subAdminDoc.save();
                                    }
                                }
                            }
                        } else {
                            const uDoc = await User.findOne({ id: String(session.chatId) });
                            if(uDoc) {
                                if(uDoc.last_active_date !== todayStr) { uDoc.today_otps = 0; uDoc.today_balance = 0; uDoc.last_active_date = todayStr; }
                                uDoc.total_otps += 1; uDoc.today_otps += 1; await uDoc.save();
                            }
                        }

                        updateGlobalStats('success');
                        updateTraffic(session.plat, session.country);
                        bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: `📱 +${number}`, copy_text: { text: `+${number}` }, style: "success" }]] }, { chat_id: session.chatId, message_id: session.msgId }).catch(()=>{});

                        const boxNumber = `╔════════════════════╗\n║ 📱 \`+${number}\` ║ LN- ${detectedLang}\n╚════════════════════╝`;
                        const otpMarkup = { 
                            inline_keyboard: [
                                [{ text: ` ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
                                [
                                    { text: "🔄 Get New Number", callback_data: "get_new_num", style: "danger" },
                                    { text: "💬 OTP Group", url: `https://t.me/${(config.otp_group||'').replace('@', '')}`, style: "primary" }
                                ]
                            ] 
                        };
                        
                        bot.sendMessage(session.chatId, `🎉 *New OTP Received* 🎉\n\n📱 *Platform:* \`${safeMD(session.plat)}\`\n🌍 *Country:* \`${safeMD(session.country)}\`\n\n${boxNumber}${earningText}`, { parse_mode: 'Markdown', reply_markup: otpMarkup }).catch(()=>{});
                        
                        if (!config.global_feed_on && config.otp_group) {
                            const safeSid = (session.plat || 'App').replace(/[^a-zA-Z0-9]/g, '');
                            const deepLinkUrl = `https://t.me/${botUsername}?start=gn_${pName}_${session.range}_${safeSid}`;
                            const groupMsg = `🎉 *New OTP Received* 🎉\n\n📱 *Platform:* \`${safeMD(session.plat)}\`\n🌍 *Country:* \`${safeMD(session.country)}\`\n🎯 *Number:* \`${session.range}\`\n\n💬 *SMS:* \`${otpData.message}\``;
                            const groupMarkup = { inline_keyboard: [[{ text: `  ${otpCode}`, copy_text: { text: otpCode }, style: "success" }], [{ text: "🚀 Get Number", url: deepLinkUrl, style: "danger" }]] };
                            bot.sendMessage(config.otp_group, groupMsg, {parse_mode: 'Markdown', reply_markup: groupMarkup}).catch(()=>{});
                        }
                        activeNumbers.delete(number);
                    }
                }
            }
        } catch(e) { }
    }
    isPollingOTP = false;
}, 1000); 

let isPollingFeed = false;
setInterval(async () => {
    if (isPollingFeed) return;
    isPollingFeed = true;
    
    const config = await getAppConfig();
    if (!config.global_feed_on || !config.otp_group) { isPollingFeed = false; return; }

    const rangesDb = await loadRanges();

    for (const pName of ['stexsms', 'voltxsms']) {
        if (pName === 'stexsms' && !config.stexsms_on) continue;
        if (pName === 'voltxsms' && !config.voltxsms_on) continue;
        if (!panelKeys[pName]) continue;
        
        try {
            const res = await panelRequest('get', '/console', null, pName);
            if (res.data && res.data.meta && res.data.meta.status === 'ok') {
                const hits = res.data.data.hits || [];
                for(let hit of hits.reverse()) {
                    const uniqueId = `${pName}_${hit.time}_${hit.range}_${hit.message.substring(0,5)}`;
                    if(!seenConsoleHits.has(uniqueId)) {
                        seenConsoleHits.add(uniqueId);
                        if(seenConsoleHits.size > 1500) { seenConsoleHits.delete(seenConsoleHits.values().next().value); }
                        
                        const otpCode = extractOTP(hit.message);
                        let consoleCountry = getCountryByCode(hit.range);
                        for (const [plat, countries] of Object.entries(rangesDb)) {
                            for (const [cName, data] of Object.entries(countries)) {
                                let rVal = typeof data === 'string' ? data : data.range;
                                if (rVal === hit.range || rVal.replace(/XXX/ig, '') === hit.range.replace(/XXX/ig, '')) {
                                    consoleCountry = cName;
                                }
                            }
                        }

                        let displaySid = hit.sid || 'Unknown';
                        const safeSid = displaySid.replace(/[^a-zA-Z0-9]/g, '');
                        const deepLinkUrl = `https://t.me/${botUsername}?start=gn_${pName}_${hit.range}_${safeSid}`;
                        const msg = `🎉 *New OTP Received* 🎉\n\n📱 *Platform:* \`${safeMD(displaySid)}\`\n🌍 *Country:* \`${safeMD(consoleCountry)}\`\n🎯 *Number:* \`${hit.range}\`\n\n💬 *SMS:* \`${hit.message}\``;
                        const markup = { inline_keyboard: [[{ text: `  ${otpCode}`, copy_text: { text: otpCode }, style: "success" }], [{ text: "🚀 Get Number", url: deepLinkUrl, style: "danger" }]] };
                        bot.sendMessage(config.otp_group, msg, {parse_mode: 'Markdown', reply_markup: markup}).catch(()=>{});
                    }
                }
            }
        } catch(e) {}
    }
    isPollingFeed = false;
}, 6000);

// 🟢 Foolproof Midnight Reset for Top 3 Bonus
setInterval(async () => {
    const now = new Date();
    const bdTimeMs = now.getTime() + (now.getTimezoneOffset() * 60000) + (6 * 3600000);
    const bdTime = new Date(bdTimeMs);
    
    if (bdTime.getHours() === 0 && bdTime.getMinutes() <= 5) {
        const todayStr = bdTime.toISOString().split('T')[0];
        try {
            const resetDoc = await Setting.findOne({ key: 'last_bonus_date' });
            if (!resetDoc || resetDoc.data !== todayStr) {
                await Setting.findOneAndUpdate({ key: 'last_bonus_date' }, { data: todayStr }, { upsert: true });

                const config = await getAppConfig();
                
                if (config.top_reward_on !== false) {
                    const topUsers = await User.find({ today_otps: { $gte: 50 }, referral_count: { $gte: 3 } }).sort({ today_otps: -1 }).limit(3);
                    
                    let broadcastTxt = "🏆 *YESTERDAY'S TOP WINNERS* 🏆\n\n";
                    let hasWinners = false;
                    const bonuses = [config.bonus_top1 || 50, config.bonus_top2 || 30, config.bonus_top3 || 20];
                    const medals = ["🥇", "🥈", "🥉"];
                    
                    for (let i = 0; i < topUsers.length; i++) {
                        hasWinners = true;
                        const u = topUsers[i];
                        const bonus = bonuses[i];
                        u.balance += bonus; await u.save();
                        broadcastTxt += `${medals[i]} *Top ${i+1}:* \`${safeMD(u.first_name)}\` (ID: \`${u.id}\`)\n🎁 *Bonus:* \`${bonus}\` ৳ | *OTPs:* ${u.today_otps}\n\n`;
                        bot.sendMessage(u.id, `🎉 *CONGRATULATIONS!*\n\n🎁 *Bonus:* \`${bonus}\` ৳ আপনার একাউন্টে যোগ করা হয়েছে!`, { parse_mode: 'Markdown' }).catch(()=>{});
                    }
                    if (hasWinners && config.otp_group) bot.sendMessage(config.otp_group, broadcastTxt, { parse_mode: 'Markdown' }).catch(()=>{});
                }
                
                await User.updateMany({}, { $set: { today_otps: 0, today_balance: 0, last_active_date: todayStr } });
            }
        } catch (e) { }
    }
}, 30000); 

// --- Commands & Messages ---
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1] ? match[1].trim() : '';
    
    if (param.startsWith('gn_')) {
        const u = await ensureUser(msg.from);
        if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' }).catch(()=>{});
        if (!(await checkForceSub(chatId))) return;

        const parts = param.split('_');
        if(parts.length >= 4) {
           const pName = parts[1]; const reqRange = parts[2]; const platName = parts.slice(3).join(' ');
           let foundCountry = getCountryByCode(reqRange);
           bot.sendMessage(chatId, "🚀 *Generating requested number...*", {parse_mode: 'Markdown'}).then(sentMsg => {
               generateNewNumber(chatId, platName, foundCountry, pName, reqRange, sentMsg.message_id);
           }).catch(()=>{});
           return;
        }
    }

    let u = await User.findOne({ id: String(chatId) });
    if (!u) {
        u = new User({ id: String(chatId), first_name: msg.from.first_name || 'User', username: msg.from.username || 'N/A', joined: new Date().toISOString(), last_active_date: getBdDateStr() });
        if (param && param !== String(chatId) && !param.startsWith('gn_')) {
            const referrer = await User.findOne({ id: param });
            if (referrer) { u.referred_by = referrer.id; referrer.referral_count = (referrer.referral_count || 0) + 1; await referrer.save(); }
        }
        await u.save();
    } else {
        const today = getBdDateStr();
        if (u.last_active_date !== today) { u.today_otps = 0; u.today_balance = 0; u.last_active_date = today; await u.save(); }
    }

    if (u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' }).catch(()=>{});
    if (!(await checkForceSub(chatId))) return;

    const safeName = safeMD(msg.from.first_name);
    const welcomeMsg = ` 💐*WELCOME TO ̲❚█══VX TEAM══█❚*\n\n👋 Hello, \`${safeName}\`!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\n👇 Please choose an option from the menu below:`;
    bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(chatId) }).catch(e => console.error("Start Err:", e.message));
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    if (text.startsWith('/')) return;

    const config = await getAppConfig();
    let checkU = await User.findOne({ id: String(chatId) });
    if (config.force_start && !checkU && text !== '/start') return bot.sendMessage(chatId, "⚠️ *বটটি ব্যবহার করতে প্রথমে /start বাটনে ক্লিক করুন!*", { parse_mode: 'Markdown' }).catch(()=>{});

    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' }).catch(()=>{});

    const menuButtons = ["📱 GET NUMBER", "📡 LIVE RANGE", "🏆 Top Users", "🎁 Referrals", "👤 ACCOUNT", "🎧 SUPPORT", "🛠️ ADMIN PANEL"];
    if (menuButtons.includes(text)) {
        if(adminState[chatId]) delete adminState[chatId];
        if(userState[chatId]) delete userState[chatId];
    }
    
    // --- USER STATE MACHINE ---
    if (userState[chatId]) {
        const state = userState[chatId];
        if (state.action === 'wait_wd_id') {
            state.account_id = text.trim();
            state.action = 'wait_wd_amount';
            bot.sendMessage(chatId, `✅ *Method:* ${state.method}\n✅ *Account/ID:* \`${state.account_id}\`\n\n💰 *এবার কত টাকা উইথড্র করতে চান তা লিখুন:*`, { parse_mode: 'Markdown' }).catch(()=>{});
            return;
        }
        else if (state.action === 'wait_wd_amount') {
            const amount = parseFloat(text.trim());
            if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ *Please enter a valid amount.*", { parse_mode: 'Markdown' }).catch(()=>{});
            
            try {
                const config = await getAppConfig();
                const userDoc = await User.findOne({ id: String(chatId) });
                
                if (state.is_sub_admin) {
                    if (amount > userDoc.sub_admin_balance) return bot.sendMessage(chatId, "❌ *Insufficient Sub Admin Balance!*", { parse_mode: 'Markdown' }).catch(()=>{});
                    userDoc.sub_admin_balance = parseFloat((userDoc.sub_admin_balance - amount).toFixed(2));
                    await userDoc.save();
                } else {
                    if (amount < config.min_withdraw) return bot.sendMessage(chatId, `⚠️ *Minimum Withdraw is ${config.min_withdraw} ৳*`, { parse_mode: 'Markdown' }).catch(()=>{});
                    if (amount > userDoc.balance) return bot.sendMessage(chatId, "❌ *Insufficient Balance!*", { parse_mode: 'Markdown' }).catch(()=>{});
                    userDoc.balance = parseFloat((userDoc.balance - amount).toFixed(2));
                    await userDoc.save();
                }

                const wd_id = Math.random().toString(36).substring(2, 10).toUpperCase();
                await Withdraw.create({ wd_id: wd_id, user_id: String(chatId), amount: amount, method: state.method, account: state.account_id, is_sub_admin: state.is_sub_admin || false, status: 'pending', date: getLocDate() });

                bot.sendMessage(chatId, `✅ *Withdraw Request Submitted!*\n\n💰 *Amount:* \`${amount}\` ৳\n💳 *Method:* ${state.method}\n\n_Please wait for approval._`, { parse_mode: 'Markdown' }).catch(()=>{});

                const wdGroupMsg = `🔔 *NEW WITHDRAW REQUEST*\n\n👤 *User ID:* \`${chatId}\`\n💳 *Method:* ${state.method}\n🏦 *Account/ID:* \`${safeMD(state.account_id)}\`\n💰 *Amount:* \`${amount}\` ৳\n⚙️ *Type:* ${state.is_sub_admin ? 'Sub Admin Profit' : 'User Balance'}\n\n_Select an action below:_`;
                const wdMarkup = { inline_keyboard: [[ { text: "✅ Approve", callback_data: `wd_appr_${wd_id}`, style: "success" }, { text: "❌ Cancel", callback_data: `wd_canc_${wd_id}`, style: "danger" } ]]};
                
                if (state.is_sub_admin) {
                    bot.sendMessage(MAIN_ADMIN_ID, wdGroupMsg, { parse_mode: 'Markdown', reply_markup: wdMarkup }).catch(()=>{});
                } else {
                    if(config.payment_group) bot.sendMessage(config.payment_group, wdGroupMsg, { parse_mode: 'Markdown', reply_markup: wdMarkup }).catch(()=>{});
                }
            } catch (e) { bot.sendMessage(chatId, "❌ Error processing request.").catch(()=>{}); }
            delete userState[chatId]; return;
        }
    }

    // --- ADMIN STATE MACHINE ---
    if (adminState[chatId] && isAdmin(chatId)) {
        const state = adminState[chatId];

        if (state.action === 'wait_site_add') {
            const siteName = text.trim();
            const ranges = await loadRanges();
            if (!ranges[siteName]) ranges[siteName] = {};
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ সাইট *${getPlatIcon(siteName)} ${safeMD(siteName)}* যুক্ত হয়েছে! এবার Manage Ranges থেকে রেঞ্জ অ্যাড করতে পারবেন।`, { parse_mode: 'Markdown' }).catch(()=>{});
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_country_name') {
            state.country = text;
            bot.sendMessage(chatId, `✅ Country: ${text}\n\n📌 এবার কোন সার্ভার থেকে রেঞ্জ অ্যাড করবেন তা সিলেক্ট করুন:`, {
                reply_markup: { inline_keyboard: [ [{ text: "⚙️ Server 1", callback_data: "setpan_stexsms", style: "primary" }, { text: "⚙️ Server 2", callback_data: "setpan_voltxsms", style: "danger" }] ]}
            }).catch(()=>{});
            return; 
        }
        else if (state.action === 'wait_range_val') {
            const ranges = await loadRanges();
            if (!ranges[state.platform]) ranges[state.platform] = {};
            ranges[state.platform][state.country] = { range: text, panel: state.panel };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ *${safeMD(state.platform)}* এর জন্য রেঞ্জ সেভ হয়েছে! (Server: ${state.panel === 'stexsms' ? '1' : '2'})`, { parse_mode: 'Markdown' }).catch(()=>{});
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_range_edit') {
            const ranges = await loadRanges();
            ranges[state.platform][state.country] = { range: text, panel: state.panel };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ Range updated successfully! (Server: ${state.panel === 'stexsms' ? '1' : '2'})`).catch(()=>{});
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_broadcast_notice') {
            bot.sendMessage(chatId, "✅ *Broadcasting...*", { parse_mode: 'Markdown' }).catch(()=>{});
            try {
                const users = await User.find({});
                users.forEach(usr => bot.sendMessage(usr.id, `📢 *Notice from Admin:*\n\n${text}`, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch (e) {} delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_manage_userid') {
            const uid = text.trim();
            const targetUser = await User.findOne({ id: String(uid) });
            if (!targetUser) { bot.sendMessage(chatId, "❌ *User not found!*", { parse_mode: 'Markdown' }).catch(()=>{}); } 
            else {
                const msgText = `👤 *USER DETAILS*\n\nID: \`${targetUser.id}\`\nName: \`${safeMD(targetUser.first_name)}\`\nUsername: \`${safeMD(targetUser.username)}\`\n\n💰 *Total Bal:* \`${parseFloat(targetUser.balance.toFixed(2))}\` ৳\n\n📊 *Total OTPs:* \`${targetUser.total_otps}\`\n🚫 *Status:* ${targetUser.banned ? 'BANNED' : 'ACTIVE'}`;
                const markup = { inline_keyboard: [[{ text: targetUser.banned ? "✅ Unban User" : "🚫 Ban User", callback_data: `adm_togban_${targetUser.id}`, style: targetUser.banned ? "success" : "danger" }]]};
                bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup }).catch(e=>console.error("Manage User Err:", e.message));
            }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_otp_rate') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.per_otp_rate = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *OTP Rate updated to ${val} ৳*`, { parse_mode: 'Markdown' }).catch(()=>{}); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_ref_com') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.ref_otp_commission = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Ref Commission updated to ${val} ৳*`, { parse_mode: 'Markdown' }).catch(()=>{}); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_t1') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.bonus_top1 = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Top 1 Bonus updated to ${val} ৳*`, { parse_mode: 'Markdown' }).catch(()=>{}); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_t2') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.bonus_top2 = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Top 2 Bonus updated to ${val} ৳*`, { parse_mode: 'Markdown' }).catch(()=>{}); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_t3') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.bonus_top3 = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Top 3 Bonus updated to ${val} ৳*`, { parse_mode: 'Markdown' }).catch(()=>{}); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_min_wd') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val > 0) { const config = await getAppConfig(); config.min_withdraw = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Min Withdraw limit updated to ${val} ৳*`, { parse_mode: 'Markdown' }).catch(()=>{}); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_pay_method_add') {
            const m = text.trim();
            if(m) {
                const config = await getAppConfig(); 
                if(!config.pay_methods.includes(m)) { config.pay_methods.push(m); await saveAppConfig(config); }
                bot.sendMessage(chatId, `✅ *Payment Method '${m}' added!*`, { parse_mode: 'Markdown' }).catch(()=>{});
            }
            delete adminState[chatId]; return;
        }
        // Force Sub / Channels Addition
        else if (state.action === 'wait_force_ch_add' && isMainAdmin(chatId)) {
            const ch = text.trim();
            const config = await getAppConfig();
            if (!Array.isArray(config.force_channels)) config.force_channels = [];
            if (!config.force_channels.includes(ch)) { config.force_channels.push(ch); await saveAppConfig(config); }
            bot.sendMessage(chatId, `✅ *Force Channel/Group added:* \`${safeMD(ch)}\`\n_Note: Ensure the bot is an admin in this channel._`, { parse_mode: 'Markdown' }).catch(()=>{});
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_set_otp_group' && isMainAdmin(chatId)) {
            const config = await getAppConfig(); config.otp_group = text.trim(); await saveAppConfig(config);
            bot.sendMessage(chatId, `✅ OTP Group updated to: \`${safeMD(text.trim())}\``, { parse_mode: 'Markdown' }).catch(()=>{});
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_set_pay_group' && isMainAdmin(chatId)) {
            const config = await getAppConfig(); config.payment_group = text.trim(); await saveAppConfig(config);
            bot.sendMessage(chatId, `✅ Payment Group updated to: \`${safeMD(text.trim())}\``, { parse_mode: 'Markdown' }).catch(()=>{});
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_set_support_usr' && isMainAdmin(chatId)) {
            let sUser = text.trim().replace('@', '');
            const config = await getAppConfig(); config.support_user = sUser; await saveAppConfig(config);
            bot.sendMessage(chatId, `✅ Support Username updated to: @${safeMD(sUser)}`).catch(()=>{});
            delete adminState[chatId]; return;
        }
    }

    if (!(await checkForceSub(chatId))) return;

    try {
        if (text === "🛠️ ADMIN PANEL" && isAdmin(chatId)) {
            bot.sendMessage(chatId, "🛠 *Admin Control Panel*\n\nSelect an option below:", { parse_mode: 'Markdown', reply_markup: getAdminMenu(chatId) }).catch(e=>console.error("Panel Err:", e.message));
        }
        else if (text === "📱 GET NUMBER") {
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const [plat, countries] of Object.entries(ranges)) {
                if (Object.keys(countries).length > 0) {
                    row.push({ text: `${getPlatIcon(plat)} ${plat.toUpperCase()}`, callback_data: `u_site_${plat}`, style: "primary" });
                    if (row.length === 2) { inlineKeyboard.push(row); row = []; }
                }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            if (inlineKeyboard.length === 0) return bot.sendMessage(chatId, "⚠️ *কোনো সাইট বা নাম্বার স্টকে নেই।*", { parse_mode: 'Markdown' }).catch(()=>{});
            bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(()=>{});
        }
        else if (text === "📡 LIVE RANGE") {
            const config = await getAppConfig();
            bot.sendMessage(chatId, "📡 *Click below to check Live Ranges & Realtime Global OTP feed:*", { 
                parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [[{ text: "🔥 Go To Live OTP Group", url: `https://t.me/${(config.otp_group||'').replace('@', '')}`, style: "danger" }]] } 
            }).catch(()=>{});
        }
        else if (text === "🏆 Top Users") {
            const todayStr = getBdDateStr();
            const topUsers = await User.find({ today_otps: { $gt: 0 }, last_active_date: todayStr }).sort({ today_otps: -1 }).limit(10);
            
            let msgText = "🏆 *TODAY'S TOP 10 USERS* 🏆\n\n";
            if (topUsers.length === 0) { msgText += "_No OTPs generated yet today._\n\n"; } 
            else {
                const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
                topUsers.forEach((u, index) => { msgText += `${medals[index] || "🏅"} *\`${safeMD(u.first_name)}\`* (ID: \`${u.id}\`)\n🎯 *OTPs:* \`${u.today_otps}\`\n\n`; });
            }
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "👁️ See Your Position", callback_data: "my_rank", style: "success" }]] } }).catch(()=>{});
        }
        else if (text === "🎁 Referrals") {
            const uData = await ensureUser(msg.from);
            const config = await getAppConfig();
            const refLink = `https://t.me/${botUsername}?start=${uData.id}`;
            const msgText = `🎁 *YOUR REFERRAL SYSTEM*\n\n🔗 *Your Referral Link:*\n\`${refLink}\`\n\n👥 *Total Referred:* \`${uData.referral_count || 0}\` Users\n💰 *Total Earnings:* \`${parseFloat((uData.referral_earnings || 0).toFixed(2))}\` ৳\n\n⚡️ _You will get ${config.ref_otp_commission || 0.05} ৳ per OTP!_`;
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (text === "👤 ACCOUNT") {
            const uData = await ensureUser(msg.from);
            const config = await getAppConfig();
            let balText = `💰 *Total Balance:* \`${parseFloat(uData.balance.toFixed(2))}\` ৳\n💸 *Today Earnings:* \`${parseFloat(uData.today_balance.toFixed(2))}\` ৳`;
            if (config.reward_system === false) balText = "";

            const msgText = `👤 *USER ACCOUNT*\n\n🔖 *ID:* \`${uData.id}\`\n👤 *Name:* \`${safeMD(uData.first_name)}\`\n\n${balText}\n\n📊 *Total OTPs:* \`${uData.total_otps}\`\n📈 *Today OTPs:* \`${uData.today_otps}\``;
            let markup = { inline_keyboard: [] };
            if (config.reward_system !== false) markup.inline_keyboard.push([{ text: "💵 Withdraw Funds", callback_data: "wd_start", style: "danger" }]);
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup }).catch(()=>{});
        }
        else if (text === "🎧 SUPPORT") {
            const config = await getAppConfig();
            const sUser = config.support_user || "developer_walid";
            bot.sendMessage(chatId, "🎧 *SUPPORT CENTER*\n\nবট ব্যবহার করতে সমস্যা হলে অ্যাডমিনকে মেসেজ দিন:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "👨‍💻 Contact Admin", url: `https://t.me/${sUser}`, style: "primary" }]] } }).catch(()=>{});
        }
    } catch (e) {
        bot.sendMessage(chatId, "⚠️ *সার্ভার ত্রুটি!*", { parse_mode: 'Markdown' }).catch(()=>{});
    }
});

// --- Callbacks ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    // 🟢 Fixed force sub validation and pop-up logic 🟢
    if (data === "check_joined") {
        const subbed = await isUserSubscribed(chatId);
        if (subbed) {
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            const u = await ensureUser(query.from);
            const safeName = safeMD(u.first_name);
            const welcomeMsg = ` 💐*WELCOME TO ̲❚█══VX TEAM══█❚*\n\n👋 Hello, \`${safeName}\`!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\n👇 Please choose an option from the menu below:`;
            bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(chatId) }).catch(()=>{});
            bot.answerCallbackQuery(query.id, { text: "✅ Successfully Joined!" }).catch(()=>{});
        } else { 
            bot.answerCallbackQuery(query.id, { text: "⚠️ আপনি এখনও সবগুলো চ্যানেলে জয়েন করেননি! দয়া করে সবগুলোতে জয়েন করে আবার ক্লিক করুন।", show_alert: true }).catch(()=>{}); 
        }
        return;
    }

    if (data === "my_rank") {
        const todayStr = getBdDateStr();
        const u = await User.findOne({ id: String(chatId) });
        if (!u || u.today_otps === 0 || u.last_active_date !== todayStr) { return bot.answerCallbackQuery(query.id, { text: `আপনি আজকে এখনও কোনো OTP পাননি!`, show_alert: true }).catch(()=>{}); } 
        else {
            const higherCount = await User.countDocuments({ today_otps: { $gt: u.today_otps }, last_active_date: todayStr });
            return bot.answerCallbackQuery(query.id, { text: `🏆 Your Position: #${higherCount + 1}\n🎯 Today's OTPs: ${u.today_otps}`, show_alert: true }).catch(()=>{});
        }
    }

    bot.answerCallbackQuery(query.id).catch(()=>{});

    try {
        if (data === "admin_main" && isAdmin(chatId)) {
            bot.editMessageText("🛠 *Admin Control Panel*\n\nSelect an option below:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getAdminMenu(chatId) }).catch(e=>console.error("Admin Main Error:", e.message));
        }
        
        else if (data === "adm_groups" && isMainAdmin(chatId)) {
            const config = await getAppConfig();
            const fChannels = Array.isArray(config.force_channels) ? config.force_channels : [];
            bot.editMessageText(`🔗 *Manage Groups & Channels*\n\n*OTP Group:* \`${safeMD(config.otp_group)}\`\n*Pay Group:* \`${safeMD(config.payment_group)}\`\n*Support:* \`@${safeMD(config.support_user)}\`\n*Force Channels:* \`${fChannels.length}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
                [{ text: "📢 Manage Force Channels", callback_data: "adm_force_list", style: "primary" }],
                [{ text: "✏️ Set OTP Group", callback_data: "set_otp_grp", style: "danger" }, { text: "✏️ Set Payment Group", callback_data: "set_pay_grp", style: "success" }],
                [{ text: "👨‍💻 Set Support Username", callback_data: "set_support_usr", style: "primary" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ]}}).catch(e=>console.error("Groups Render Error:", e.message));
        }
        else if (data === "adm_force_list" && isMainAdmin(chatId)) {
            const config = await getAppConfig();
            let kb = [];
            const fChannels = Array.isArray(config.force_channels) ? config.force_channels : [];
            fChannels.forEach((ch, idx) => { kb.push([{ text: `🗑️ Remove: ${ch}`, callback_data: `del_force_${idx}`, style: "danger" }]); });
            kb.push([{ text: "➕ Add Force Channel", callback_data: "add_force_ch", style: "success" }]);
            kb.push([{ text: "🔙 Back", callback_data: "adm_groups", style: "primary" }]);
            bot.editMessageText("📢 *Manage Force Channels*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb }}).catch(()=>{});
        }
        else if (data === "add_force_ch" && isMainAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_force_ch_add' };
            bot.sendMessage(chatId, "✏️ Enter Channel username (e.g. @mychannel) or ID (-100xxxx):").catch(()=>{});
        }
        else if (data.startsWith('del_force_') && isMainAdmin(chatId)) {
            const idx = parseInt(data.split('_')[2]);
            const config = await getAppConfig();
            if (!Array.isArray(config.force_channels)) config.force_channels = [];
            config.force_channels.splice(idx, 1);
            await saveAppConfig(config);
            bot.editMessageText(`✅ Channel Removed!`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_force_list", style: "danger" }]] } }).catch(()=>{});
        }
        else if (data === "set_otp_grp" && isMainAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_set_otp_group' }; bot.sendMessage(chatId, "✏️ Enter OTP Group Link or Username:").catch(()=>{});
        }
        else if (data === "set_pay_grp" && isMainAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_set_pay_group' }; bot.sendMessage(chatId, "✏️ Enter Payment Group Link or Username:").catch(()=>{});
        }
        else if (data === "set_support_usr" && isMainAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_set_support_usr' }; bot.sendMessage(chatId, "✏️ Enter Support Admin's Username (e.g. your_id):").catch(()=>{});
        }
        
        else if (data === "adm_sub_balance" && String(chatId) === SUB_ADMIN_ID) {
            const subDoc = await User.findOne({ id: String(SUB_ADMIN_ID) });
            bot.editMessageText(`💰 *Sub Admin Profit Balance*\n\n💵 *Total Balance:* \`${parseFloat((subDoc.sub_admin_balance||0).toFixed(2))}\` ৳\n\n_Note: You earn a profit margin on every successful OTP._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
                [{ text: "💸 Withdraw Profit", callback_data: "sub_wd_start", style: "success" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ]}}).catch(()=>{});
        }
        else if (data === "sub_wd_start" && String(chatId) === SUB_ADMIN_ID) {
            const config = await getAppConfig();
            let inlineKeyboard = [];
            config.pay_methods.forEach(m => { inlineKeyboard.push([{ text: `💳 ${m}`, callback_data: `subwd_m_${m}`, style: "primary" }]); });
            bot.sendMessage(chatId, "📌 *Select Withdrawal Method for Profit:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(()=>{});
        }
        else if (data.startsWith('subwd_m_') && String(chatId) === SUB_ADMIN_ID) {
            const method = data.split('subwd_m_')[1];
            userState[chatId] = { action: 'wait_wd_id', method: method, is_sub_admin: true };
            bot.sendMessage(chatId, `✏️ *আপনার ${method} Account ID / Number দিন:*`, { parse_mode: 'Markdown' }).catch(()=>{});
        }

        else if (data === "adm_bot_settings" && isMainAdmin(chatId)) {
            const config = await getAppConfig();
            let kb = [
                [{ text: `⚙️ Server 1: ${config.stexsms_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_stexsms", style: "primary" }],
                [{ text: `⚙️ Server 2: ${config.voltxsms_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_voltxsms", style: "danger" }],
                [{ text: `🚀 Force /start: ${config.force_start ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_forcestart", style: "success" }],
                [{ text: `🌐 Global Live OTP: ${config.global_feed_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_globalfeed", style: "primary" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText("⚙️ *Bot Settings*\n\nপ্যানেল এবং অন্যান্য সেটিংস অন/অফ করুন:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data.startsWith("tog_") && isMainAdmin(chatId)) {
            const key = data.split('_')[1];
            const config = await getAppConfig();
            if (key === 'stexsms') config.stexsms_on = !config.stexsms_on;
            if (key === 'voltxsms') config.voltxsms_on = !config.voltxsms_on;
            if (key === 'forcestart') config.force_start = !config.force_start;
            if (key === 'globalfeed') config.global_feed_on = !config.global_feed_on;
            await saveAppConfig(config);
            bot.editMessageText("✅ Changed successfully. Open Settings again.", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_bot_settings", style: "primary" }]] } }).catch(()=>{});
        }

        else if (data.startsWith('setpan_') && isAdmin(chatId)) {
            const panel = data.split('_')[1];
            if (adminState[chatId] && adminState[chatId].country) {
                adminState[chatId].panel = panel;
                adminState[chatId].action = 'wait_range_val';
                bot.editMessageText(`✅ Panel Selected\n\n✏️ এবার রেঞ্জ টাইপ করুন (যেমন: 26134 বা 22501XXX):`, {chat_id: chatId, message_id: msgId}).catch(()=>{});
            }
        }
        
        else if (data === "adm_dash" && isAdmin(chatId)) {
            const totalUsers = await User.countDocuments();
            const userStats = await User.aggregate([ { $group: { _id: null, totalOtps: { $sum: "$total_otps" }, todayOtps: { $sum: "$today_otps" }, totalBalance: { $sum: "$balance" } } } ]);
            const wdStats = await Withdraw.aggregate([ { $match: { status: 'approved' } }, { $group: { _id: null, totalWd: { $sum: "$amount" } } } ]);

            const tOtp = userStats.length > 0 ? userStats[0].totalOtps : 0;
            const tTodayOtp = userStats.length > 0 ? userStats[0].todayOtps : 0;
            const tBal = userStats.length > 0 ? parseFloat(userStats[0].totalBalance.toFixed(2)) : 0;
            const tWd = wdStats.length > 0 ? parseFloat(wdStats[0].totalWd.toFixed(2)) : 0;

            const dashText = `📊 *ADVANCED DASHBOARD*\n\n👥 *Total Users:* \`${totalUsers}\`\n\n📈 *OTP Stats:*\n✅ Lifetime OTPs: \`${tOtp}\`\n🔥 Today OTPs: \`${tTodayOtp}\`\n\n💰 *Finance:*\n💵 Total User Balance: \`${tBal}\` ৳\n💸 Total Approved Withdraw: \`${tWd}\` ৳`;
            bot.editMessageText(dashText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]] }}).catch(()=>{});
        }
        
        else if (data.startsWith('adm_togban_') && isAdmin(chatId)) {
            const targetId = data.split('_')[2];
            const targetUser = await User.findOne({ id: String(targetId) });
            if (targetUser) {
                targetUser.banned = !targetUser.banned;
                await targetUser.save();
                bot.editMessageText(`✅ *User ${targetUser.banned ? 'BANNED' : 'UNBANNED'} successfully!*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            }
        }

        else if (data.startsWith('wd_appr_')) {
            const wd_id = data.split('wd_appr_')[1];
            await Withdraw.findOneAndUpdate({ wd_id }, { status: 'approved' });
            bot.editMessageText("✅ *Approved!*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (data.startsWith('wd_canc_')) {
            const wd_id = data.split('wd_canc_')[1];
            await Withdraw.findOneAndUpdate({ wd_id }, { status: 'cancelled' });
            bot.editMessageText("❌ *Cancelled!*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
        }

        else if (data === "adm_broadcast" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_broadcast_notice' }; bot.sendMessage(chatId, "✏️ *সব ইউজারদের পাঠানোর জন্য মেসেজটি লিখুন:*", { parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (data === "adm_users" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_manage_userid' }; bot.sendMessage(chatId, "✏️ *Enter User ID to manage:*", { parse_mode: 'Markdown' }).catch(()=>{});
        }
        
        else if (data === "adm_paycfg" && isAdmin(chatId)) {
            const config = await getAppConfig();
            let msg = `💳 *Payment & Reward Settings*\n\n💰 *Per OTP Earning:* \`${config.per_otp_rate}\` ৳\n📉 *Min Withdraw:* \`${config.min_withdraw}\` ৳\n👥 *Ref Comm/OTP:* \`${config.ref_otp_commission || 0.05}\` ৳\n🏆 *Top Bonus:* 1st:\`${config.bonus_top1 || 50}\` | 2nd:\`${config.bonus_top2 || 30}\` | 3rd:\`${config.bonus_top3 || 20}\`\n💳 *Methods:* \`${safeMD(config.pay_methods.join(', ') || 'None')}\``;
            let kb = [
                [{ text: `🎁 Reward System: ${config.reward_system ? "ON 🟢" : "OFF 🔴"}`, callback_data: "adm_tog_reward", style: "danger" }],
                [{ text: `🏆 Top Reward System: ${config.top_reward_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "adm_tog_topreward", style: "primary" }],
                [{ text: "✏️ Edit Earning/OTP", callback_data: "adm_edit_otprate", style: "primary" }, { text: "✏️ Ref Comm/OTP", callback_data: "adm_edit_refcom", style: "primary" }],
                [{ text: "🥇 Top 1", callback_data: "adm_t1", style: "success" }, { text: "🥈 Top 2", callback_data: "adm_t2", style: "success" }, { text: "🥉 Top 3", callback_data: "adm_t3", style: "success" }],
                [{ text: "✏️ Edit Min Withdraw", callback_data: "adm_edit_minwd", style: "primary" }],
                [{ text: "➕ Add Pay Method", callback_data: "adm_add_paym", style: "danger" }, { text: "🗑️ Del Method", callback_data: "adm_del_paym", style: "danger" }],
                [{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(e=>console.error("PayCfg Err:", e.message));
        }
        else if (data === "adm_tog_reward" && isAdmin(chatId)) {
            const config = await getAppConfig();
            config.reward_system = !config.reward_system; await saveAppConfig(config);
            bot.editMessageText("✅ Changed! Re-open settings.", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_paycfg", style: "primary" }]] } }).catch(()=>{});
        }
        else if (data === "adm_tog_topreward" && isAdmin(chatId)) {
            const config = await getAppConfig();
            config.top_reward_on = !config.top_reward_on; await saveAppConfig(config);
            bot.editMessageText("✅ Changed! Re-open settings.", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_paycfg", style: "primary" }]] } }).catch(()=>{});
        }
        else if (data === "adm_edit_otprate" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_otp_rate' }; bot.sendMessage(chatId, "✏️ *Enter new earning per OTP (৳):*", { parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (data === "adm_edit_refcom" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_ref_com' }; bot.sendMessage(chatId, "✏️ *Enter Referral Commission per OTP (৳):*", { parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (data === "adm_t1" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_t1' }; bot.sendMessage(chatId, "✏️ *Enter Top 1 Bonus Amount (৳):*", { parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (data === "adm_t2" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_t2' }; bot.sendMessage(chatId, "✏️ *Enter Top 2 Bonus Amount (৳):*", { parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (data === "adm_t3" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_t3' }; bot.sendMessage(chatId, "✏️ *Enter Top 3 Bonus Amount (৳):*", { parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (data === "adm_edit_minwd" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_min_wd' }; bot.sendMessage(chatId, "✏️ *Enter new minimum withdraw limit (৳):*", { parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (data === "adm_add_paym" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_pay_method_add' }; bot.sendMessage(chatId, "✏️ *Enter new payment method name:*", { parse_mode: 'Markdown' }).catch(()=>{});
        }
        else if (data === "adm_del_paym" && isAdmin(chatId)) {
            const config = await getAppConfig();
            let kb = [];
            config.pay_methods.forEach(m => { kb.push([{ text: `🗑️ ${m}`, callback_data: `admdel_m_${m}`, style: "danger" }]); });
            kb.push([{ text: "🔙 Back", callback_data: "adm_paycfg", style: "primary" }]);
            bot.editMessageText("📌 *Select method to delete:*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data.startsWith('admdel_m_') && isAdmin(chatId)) {
            const m = data.split('admdel_m_')[1];
            const config = await getAppConfig();
            config.pay_methods = config.pay_methods.filter(x => x !== m);
            await saveAppConfig(config);
            bot.editMessageText(`✅ Deleted '${m}'`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_paycfg", style: "success" }]] } }).catch(()=>{});
        }
        
        else if (data === "adm_sites" && isAdmin(chatId)) {
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) { inlineKeyboard.push([{ text: `❌ Delete ${getPlatIcon(plat)} ${plat}`, callback_data: `del_site_${plat}`, style: "danger" }]); }
            inlineKeyboard.push([{ text: "➕ Add New Site", callback_data: "add_site", style: "success" }, { text: "🔙 Back", callback_data: "admin_main", style: "primary" }]);
            bot.editMessageText("🌐 *Manage Sites*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data === "add_site" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_site_add' }; 
            bot.sendMessage(chatId, "✏️ নতুন সাইটের নাম দিন (যেমন: Facebook):").catch(()=>{});
        }
        else if (data.startsWith('del_site_') && isAdmin(chatId)) {
            const plat = data.split('del_site_')[1];
            const ranges = await loadRanges() || {};
            if(ranges[plat]) { delete ranges[plat]; await saveRanges(ranges); }
            bot.editMessageText(`✅ ${plat} ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_sites", style: "danger" }]] } }).catch(()=>{});
        }
        else if (data === "adm_ranges" && isAdmin(chatId)) {
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) { inlineKeyboard.push([{ text: `${getPlatIcon(plat)} ${plat}`, callback_data: `ar_p_${plat}`, style: "primary" }]); }
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main", style: "danger" }]);
            bot.editMessageText("⚙️ *Select Site to Manage Ranges*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_p_') && isAdmin(chatId)) {
            const plat = data.split('_').slice(2).join('_');
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            if (ranges[plat]) {
                for (const country of Object.keys(ranges[plat])) { inlineKeyboard.push([{ text: `🌍 ${country}`, callback_data: `ar_c_${plat}_${country}`, style: "success" }]); }
            }
            inlineKeyboard.push([{ text: "➕ Add Country & Range", callback_data: `ar_add_${plat}`, style: "primary" }, { text: "🔙 Back", callback_data: "adm_ranges", style: "danger" }]);
            bot.editMessageText(`⚙️ *Manage Countries: ${getPlatIcon(plat)} ${plat}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_add_') && isAdmin(chatId)) {
            const plat = data.split('_').slice(2).join('_');
            adminState[chatId] = { action: 'wait_country_name', platform: plat };
            bot.sendMessage(chatId, "✏️ নতুন কান্ট্রির নাম ও ফ্ল্যাগ দিন (যেমন: 🇧🇩 Bangladesh):").catch(()=>{});
        }
        else if (data.startsWith('ar_c_') && isAdmin(chatId)) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges() || {};
            const rangeData = ranges[plat]?.[country];
            const currentRange = typeof rangeData === 'string' ? rangeData : (rangeData ? rangeData.range : "Not set");
            const currentPanel = typeof rangeData === 'string' ? 'stexsms' : (rangeData ? rangeData.panel : "stexsms");
            
            let inlineKeyboard = [
                [{ text: "✏️ Edit Range", callback_data: `ar_ed_${plat}_${country}`, style: "primary" }, { text: "❌ Delete Country", callback_data: `ar_del_${plat}_${country}`, style: "danger" }],
                [{ text: "🔙 Back", callback_data: `ar_p_${plat}`, style: "success" }]
            ];
            bot.editMessageText(`⚙️ *Platform:* \`${safeMD(plat)}\`\n🌍 *Country:* \`${safeMD(country)}\`\n🔌 *Server:* ${currentPanel === 'stexsms' ? '1' : '2'}\n🔢 *Current Range:* \`${currentRange}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_ed_') && isAdmin(chatId)) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            adminState[chatId] = { action: 'wait_range_edit_panel', platform: plat, country: country };
            
            bot.editMessageText(`📌 কোন সার্ভারের রেঞ্জ আপডেট করবেন?`, { chat_id: chatId, message_id: msgId, reply_markup: {
                inline_keyboard: [[{text: "⚙️ Server 1", callback_data:"edpan_stexsms", style: "primary"}, {text: "⚙️ Server 2", callback_data:"edpan_voltxsms", style: "danger"}]]
            }}).catch(()=>{});
        }
        else if (data.startsWith('edpan_') && isAdmin(chatId)) {
            const p = data.split('_')[1];
            if(adminState[chatId] && adminState[chatId].platform) {
                adminState[chatId].panel = p;
                adminState[chatId].action = 'wait_range_edit';
                bot.editMessageText(`✅ Server: ${p === 'stexsms' ? '1' : '2'}\n\n✏️ এবার নতুন রেঞ্জ টাইপ করুন:`, {chat_id: chatId, message_id: msgId}).catch(()=>{});
            }
        }
        else if (data.startsWith('ar_del_') && isAdmin(chatId)) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges() || {};
            if (ranges[plat] && ranges[plat][country]) { delete ranges[plat][country]; await saveRanges(ranges); }
            bot.editMessageText(`✅ কান্ট্রি ও রেঞ্জ ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: `ar_p_${plat}`, style: "primary" }]] } }).catch(()=>{});
        }

        else if (data === "wd_start") {
            const config = await getAppConfig();
            if (config.reward_system === false) return bot.sendMessage(chatId, "⚠️ Reward system is currently disabled.").catch(()=>{});
            let methods = config.pay_methods || [];
            if(methods.length === 0) return bot.sendMessage(chatId, "⚠️ No payment methods available.").catch(()=>{});
            let inlineKeyboard = [];
            methods.forEach(m => { inlineKeyboard.push([{ text: `💳 ${m}`, callback_data: `wd_m_${m}`, style: "success" }]); });
            bot.sendMessage(chatId, "📌 *Select Payment Method:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(()=>{});
        }
        else if (data.startsWith('wd_m_')) {
            const method = data.split('wd_m_')[1];
            userState[chatId] = { action: 'wait_wd_id', method: method };
            bot.sendMessage(chatId, `✏️ *আপনার ${method} Account ID / Number দিন:*`, { parse_mode: 'Markdown' }).catch(()=>{});
        }

        else if (data.startsWith('u_site_')) {
            const plat = data.split('_').slice(2).join('_');
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const country of Object.keys(ranges[plat] || {})) {
                row.push({ text: country, callback_data: `u_cntry_${plat}_${country}`, style: "primary" });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            bot.editMessageText(`📌 *Select Country for ${getPlatIcon(plat)} ${safeMD(plat.toUpperCase())}:*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('u_cntry_')) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            await generateNewNumber(chatId, plat, country, null, null, null);
        }
        else if (data.startsWith('cancel_')) {
            const num = data.split('_')[1];
            const session = activeNumbers.get(num);
            if (session && session.chatId === chatId) {
                activeNumbers.delete(num);
                bot.editMessageText("❌ *Number Cancelled.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            } else { 
                bot.editMessageText("❌ *Session Expired or Already Processed.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{}); 
            }
        }
        else if (data.startsWith('change_')) {
            const num = data.split('_')[1];
            const session = activeNumbers.get(num);
            if (session && session.chatId === chatId) {
                const { plat, country, panel, range } = session;
                activeNumbers.delete(num);
                bot.editMessageText("❌ *Number Cancelled. Generating New...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                await generateNewNumber(chatId, plat, country, panel, range, msgId);
            } else { 
                bot.editMessageText("❌ *Session Expired or Already Processed.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{}); 
            }
        }
        else if (data === "get_new_num") {
            const lastSession = userLastSession.get(chatId);
            if (lastSession) {
                bot.sendMessage(chatId, "🚀 *Generating requested number...*", {parse_mode: 'Markdown'}).then(sentMsg => {
                    generateNewNumber(chatId, lastSession.plat, lastSession.country, lastSession.panel, lastSession.range, sentMsg.message_id);
                }).catch(()=>{});
            } else {
                bot.sendMessage(chatId, "📌 *Session expired. Go to GET NUMBER from menu to start again.*", { parse_mode: 'Markdown' }).catch(()=>{});
            }
        }
    } catch(e) { console.error("Callback Core Error:", e.message); }
});

Promise.all([loadPanelKeys()]).then(() => console.log("🔑 Settings Loaded. Default APIs Injected. Dashboard Aggregation Enabled."));
