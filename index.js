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
app.get('/', (req, res) => res.send('Premium Fire OTP Bot - Ultra Fast V31 (Support & New UI) Running!'));
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
const MAIN_ADMIN_ID = parseInt(process.env.MAIN_ADMIN_ID);
const SUB_ADMIN_ID = parseInt(process.env.SUB_ADMIN_ID);
const NUMBER_EXPIRY_MS = 15 * 60 * 1000; 
const BASE_OTP_REVENUE = 0.40; 

function isAdmin(id) { return id === MAIN_ADMIN_ID || id === SUB_ADMIN_ID; }
function isMainAdmin(id) { return id === MAIN_ADMIN_ID; }

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
bot.getMe().then(me => { botUsername = me.username; });

let adminState = {};
let userState = {};

// ==========================================
// 🚀 DUAL PANEL API SETUP
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
// ⚙️ CONFIG & STATE MANAGERS 
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
        if (config.pay_methods === undefined) config.pay_methods = ['Binance'];
        if (config.reward_system === undefined) config.reward_system = true;
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
        if (config.force_channels === undefined) config.force_channels = []; 
        if (config.support_user === undefined) config.support_user = "admin"; // New Setting
        return config;
    } catch(e) { 
        return { per_otp_rate: 0.20, min_withdraw: 50, pay_methods: ['Binance'], reward_system: true, stexsms_on: true, voltxsms_on: true, force_start: false, global_feed_on: true, ref_otp_commission: 0.05, bonus_top1: 50, bonus_top2: 30, bonus_top3: 20, otp_group: "@otp_number_grp", payment_group: "-1003925192534", force_channels: [], support_user: "admin" }; 
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
async function getTraffic() {
    try { const doc = await Setting.findOne({ key: 'traffic' }); return doc && doc.data ? doc.data : {}; } catch(e){ return {}; }
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
    if(p.includes('insta')) return '📸';
    if(p.includes('face')) return '🧿';
    if(p.includes('whats')) return '🍏';
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
    for (let p of prefixes) {
        if (cleanRange.startsWith(p)) return codeMap[p];
    }
    return "Global";
}

// 🟢 NEW UI: Main Menu Setup
function getMainMenu(chatId) {
    let kb = [
        [{ text: "📲 GET OTP NUMBER" }],
        [{ text: "🌐 LIVE FEED" }], 
        [{ text: "🏆 Top Leaders" }, { text: "💸 Refer & Earn" }],
        [{ text: "💼 MY ACCOUNT" }, { text: "💬 HELP & SUPPORT" }]
    ];
    if (isAdmin(chatId)) kb.push([{ text: "⚙️ ADMIN SETUP" }]);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

// 🟢 NEW UI: Admin Menu Setup
function getAdminMenu(chatId) {
    let kb = [
        [{ text: "🌍 Manage Sites", callback_data: "adm_sites" }, { text: "🔢 Manage Ranges", callback_data: "adm_ranges" }],
        [{ text: "📈 Dashboard", callback_data: "adm_dash" }, { text: "📢 Broadcast", callback_data: "adm_broadcast" }],
        [{ text: "👥 Manage Users", callback_data: "adm_users" }, { text: "💳 Payment Config", callback_data: "adm_paycfg" }]
    ];
    
    if (chatId === SUB_ADMIN_ID) {
        kb.push([{ text: "🤑 Sub Admin Balance", callback_data: "adm_sub_balance" }]);
    }
    if (isMainAdmin(chatId)) {
        kb.push([{ text: "🛠 Bot Settings", callback_data: "adm_bot_settings" }, { text: "🔗 Groups & Support", callback_data: "adm_groups" }]);
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

async function checkForceSub(chatId) {
    if (isAdmin(chatId)) return true;
    const config = await getAppConfig();
    const channels = config.force_channels || [];
    if (channels.length === 0) return true;

    let isSubscribed = true;
    let buttons = [];

    for (let ch of channels) {
        if (!ch) continue;
        try {
            const member = await bot.getChatMember(ch, chatId);
            if (member.status === 'left' || member.status === 'kicked') {
                isSubscribed = false;
                buttons.push([{ text: `📣 Join Channel`, url: ch.startsWith('http') ? ch : `https://t.me/${ch.replace('@', '')}` }]);
            }
        } catch (e) {
            isSubscribed = false;
            buttons.push([{ text: `📣 Join Channel`, url: ch.startsWith('http') ? ch : `https://t.me/${ch.replace('@', '')}` }]);
        }
    }

    if (!isSubscribed) {
        buttons.push([{ text: "🟢 Joined (Check Again)", callback_data: "check_joined" }]);
        bot.sendMessage(chatId, "⚠️ *বট ব্যবহার করতে নিচের চ্যানেলগুলোতে জয়েন করুন:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        return false;
    }
    return true;
}

async function isUserSubscribed(chatId) {
    if (isAdmin(chatId)) return true;
    const config = await getAppConfig();
    const channels = config.force_channels || [];
    if (channels.length === 0) return true;
    for (let ch of channels) {
        if (!ch) continue;
        try {
            const member = await bot.getChatMember(ch, chatId);
            if (member.status === 'left' || member.status === 'kicked') return false;
        } catch (e) { return false; }
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
            const text = `📱 *Platform:* ${getPlatIcon(plat)} ${plat}\n🌍 *Country:* ${country}\n\n╔════════════════════╗\n║ ⏳ \`Wait for auto OTP...\`\n╚════════════════════╝`;
            const actionMarkup = { 
                inline_keyboard: [
                    [{ text: `📞 ${fullPhone}`, copy_text: { text: fullPhone } }],
                    [{ text: "♻️ Change Number", callback_data: `change_${strippedPhone}` }]
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
// 🔄 BACKGROUND TASKS 
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

                                // 🔥 Sub Admin Profit Logic
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
                        bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: `📞 +${number}`, copy_text: { text: `+${number}` } }]] }, { chat_id: session.chatId, message_id: session.msgId }).catch(()=>{});

                        const boxNumber = `╔════════════════════╗\n║ 💬 \`${otpCode}\` ║ LN- ${detectedLang}\n╚════════════════════╝`;
                        const otpMarkup = { 
                            inline_keyboard: [
                                [{ text: `📋 Copy OTP`, copy_text: { text: otpCode } }],
                                [
                                    { text: "🚀 Get New Number", callback_data: "get_new_num" },
                                    { text: "👥 OTP Group", url: `https://t.me/${(config.otp_group||'').replace('@', '')}` }
                                ]
                            ] 
                        };
                        
                        bot.sendMessage(session.chatId, `🎉 *New OTP Received* 🎉\n\n📱 *Platform:* ${session.plat}\n🌍 *Country:* ${session.country}\n\n${boxNumber}${earningText}`, { parse_mode: 'Markdown', reply_markup: otpMarkup }).catch(()=>{});
                        
                        if (!config.global_feed_on && config.otp_group) {
                            const safeSid = (session.plat || 'App').replace(/[^a-zA-Z0-9]/g, '');
                            const deepLinkUrl = `https://t.me/${botUsername}?start=gn_${pName}_${session.range}_${safeSid}`;
                            const groupMsg = `🎉 *New OTP Received* 🎉\n\n📱 *Platform:* ${session.plat}\n🌍 *Country:* ${session.country}\n🎯 *Number:* \`${session.range}\`\n\n💬 *SMS:* \`${otpData.message}\``;
                            const groupMarkup = { inline_keyboard: [[{ text: `📋 Copy: ${otpCode}`, copy_text: { text: otpCode } }], [{ text: "🔥 Get This Number", url: deepLinkUrl }]] };
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
                        const msg = `🎉 *New OTP Received* 🎉\n\n📱 *Platform:* ${displaySid}\n🌍 *Country:* ${consoleCountry}\n🎯 *Number:* \`${hit.range}\`\n\n💬 *SMS:* \`${hit.message}\``;
                        const markup = { inline_keyboard: [[{ text: `📋 Copy: ${otpCode}`, copy_text: { text: otpCode } }], [{ text: "🔥 Get This Number", url: deepLinkUrl }]] };
                        bot.sendMessage(config.otp_group, msg, {parse_mode: 'Markdown', reply_markup: markup}).catch(()=>{});
                    }
                }
            }
        } catch(e) {}
    }
    isPollingFeed = false;
}, 6000);

// 🟢 Top 3 Bonus System
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
                    broadcastTxt += `${medals[i]} *Top ${i+1}:* ${u.first_name} (ID: \`${u.id}\`)\n🎁 *Bonus:* \`${bonus}\` ৳ | *OTPs:* ${u.today_otps}\n\n`;
                    bot.sendMessage(u.id, `🎉 *CONGRATULATIONS!*\n\n🎁 *Bonus:* \`${bonus}\` ৳ আপনার একাউন্টে যোগ করা হয়েছে!`, { parse_mode: 'Markdown' }).catch(()=>{});
                }
                
                if (hasWinners && config.otp_group) bot.sendMessage(config.otp_group, broadcastTxt, { parse_mode: 'Markdown' }).catch(()=>{});
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
        if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' });
        if (!(await checkForceSub(chatId))) return;

        const parts = param.split('_');
        if(parts.length >= 4) {
           const pName = parts[1]; const reqRange = parts[2]; const platName = parts.slice(3).join(' ');
           let foundCountry = getCountryByCode(reqRange);
           bot.sendMessage(chatId, "🚀 *Generating requested number...*", {parse_mode: 'Markdown'}).then(sentMsg => {
               generateNewNumber(chatId, platName, foundCountry, pName, reqRange, sentMsg.message_id);
           });
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

    if (u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' });
    if (!(await checkForceSub(chatId))) return;

    const welcomeMsg = ` 💐*WELCOME TO PREMIUM FIRE OTP*\n\n👋 Hello, *${msg.from.first_name}*!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform._\n\n👇 Please choose an option from the menu:`;
    bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(chatId) });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    if (text.startsWith('/')) return;

    const config = await getAppConfig();
    let checkU = await User.findOne({ id: String(chatId) });
    if (config.force_start && !checkU && text !== '/start') return bot.sendMessage(chatId, "⚠️ *Please click /start first!*", { parse_mode: 'Markdown' });

    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(chatId, "🚫 *You are banned.*", { parse_mode: 'Markdown' });

    const menuButtons = ["📲 GET OTP NUMBER", "🌐 LIVE FEED", "🏆 Top Leaders", "💸 Refer & Earn", "💼 MY ACCOUNT", "💬 HELP & SUPPORT", "⚙️ ADMIN SETUP"];
    if (menuButtons.some(btn => text.includes(btn))) {
        if(adminState[chatId]) delete adminState[chatId];
        if(userState[chatId]) delete userState[chatId];
    }
    
    // --- USER STATE MACHINE ---
    if (userState[chatId]) {
        const state = userState[chatId];
        if (state.action === 'wait_wd_id') {
            state.account_id = text.trim();
            state.action = 'wait_wd_amount';
            bot.sendMessage(chatId, `🟢 *Method:* ${state.method}\n🟢 *Account/ID:* \`${state.account_id}\`\n\n💰 *Enter withdrawal amount:*`, { parse_mode: 'Markdown' });
            return;
        }
        else if (state.action === 'wait_wd_amount') {
            const amount = parseFloat(text.trim());
            if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ *Please enter a valid amount.*", { parse_mode: 'Markdown' });
            
            try {
                const config = await getAppConfig();
                const userDoc = await User.findOne({ id: String(chatId) });
                
                if (state.is_sub_admin) {
                    if (amount > userDoc.sub_admin_balance) return bot.sendMessage(chatId, "❌ *Insufficient Sub Admin Balance!*", { parse_mode: 'Markdown' });
                    userDoc.sub_admin_balance = parseFloat((userDoc.sub_admin_balance - amount).toFixed(2));
                    await userDoc.save();
                } else {
                    if (amount < config.min_withdraw) return bot.sendMessage(chatId, `⚠️ *Minimum Withdraw is ${config.min_withdraw} ৳*`, { parse_mode: 'Markdown' });
                    if (amount > userDoc.balance) return bot.sendMessage(chatId, "❌ *Insufficient Balance!*", { parse_mode: 'Markdown' });
                    userDoc.balance = parseFloat((userDoc.balance - amount).toFixed(2));
                    await userDoc.save();
                }

                const wd_id = Math.random().toString(36).substring(2, 10).toUpperCase();
                await Withdraw.create({ wd_id: wd_id, user_id: String(chatId), amount: amount, method: state.method, account: state.account_id, is_sub_admin: state.is_sub_admin || false, status: 'pending', date: getLocDate() });

                bot.sendMessage(chatId, `✅ *Withdraw Request Submitted!*\n\n💰 *Amount:* \`${amount}\` ৳\n💳 *Method:* ${state.method}\n\n_Please wait for approval._`, { parse_mode: 'Markdown' });

                const wdGroupMsg = `🔔 *NEW WITHDRAW REQUEST*\n\n👤 *User ID:* \`${chatId}\`\n💳 *Method:* ${state.method}\n🏦 *Account/ID:* \`${state.account_id}\`\n💰 *Amount:* \`${amount}\` ৳\n⚙️ *Type:* ${state.is_sub_admin ? 'Sub Admin Profit' : 'User Balance'}\n\n_Select an action below:_`;
                const wdMarkup = { inline_keyboard: [[ { text: "✅ Approve", callback_data: `wd_appr_${wd_id}` }, { text: "❌ Cancel", callback_data: `wd_canc_${wd_id}` } ]]};
                
                if (state.is_sub_admin) {
                    bot.sendMessage(MAIN_ADMIN_ID, wdGroupMsg, { parse_mode: 'Markdown', reply_markup: wdMarkup }).catch(()=>{});
                } else {
                    if(config.payment_group) bot.sendMessage(config.payment_group, wdGroupMsg, { parse_mode: 'Markdown', reply_markup: wdMarkup }).catch(()=>{});
                }
            } catch (e) { bot.sendMessage(chatId, "❌ Error processing request."); }
            delete userState[chatId]; return;
        }
    }

    // --- ADMIN STATE MACHINE ---
    if (adminState[chatId] && isAdmin(chatId)) {
        const state = adminState[chatId];

        // 🟢 FIX: Site Add Logic
        if (state.action === 'wait_site_add') {
            const ranges = await loadRanges();
            const siteName = text.trim();
            if (!ranges[siteName]) ranges[siteName] = {};
            await saveRanges(ranges);
            
            const platDisplay = `${getPlatIcon(siteName)} ${siteName.toUpperCase()}`;
            bot.sendMessage(chatId, `✅ সাইট *${platDisplay}* সফলভাবে যুক্ত হয়েছে!\n\nএখন নিচের বাটনে ক্লিক করে সরাসরি রেঞ্জ অ্যাড করুন:`, { 
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: `➕ Add Range for ${siteName}`, callback_data: `ar_add_${siteName}` }]] }
            });
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_country_name') {
            state.country = text.trim();
            bot.sendMessage(chatId, `✅ Country: ${state.country}\n\n📌 এবার কোন সার্ভার থেকে রেঞ্জ অ্যাড করবেন তা সিলেক্ট করুন:`, {
                reply_markup: { inline_keyboard: [ [{ text: "⚙️ Server 1", callback_data: "setpan_stexsms" }, { text: "⚙️ Server 2", callback_data: "setpan_voltxsms" }] ]}
            });
            return; 
        }
        else if (state.action === 'wait_range_val') {
            const ranges = await loadRanges();
            if (!ranges[state.platform]) ranges[state.platform] = {};
            ranges[state.platform][state.country] = { range: text.trim(), panel: state.panel };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ *${state.platform}* এর রেঞ্জ সেভ হয়েছে! (Server: ${state.panel === 'stexsms' ? '1' : '2'})`, { parse_mode: 'Markdown' });
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_range_edit') {
            const ranges = await loadRanges();
            ranges[state.platform][state.country] = { range: text.trim(), panel: state.panel };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `✅ Range updated successfully!`);
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_broadcast_notice') {
            bot.sendMessage(chatId, "✅ *Broadcasting...*", { parse_mode: 'Markdown' });
            try {
                const users = await User.find({});
                users.forEach(usr => bot.sendMessage(usr.id, `📢 *Notice:*\n\n${text}`, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch (e) {} delete adminState[chatId]; return;
        }
        
        // 🟢 FIX: User & Payment Handlers Restored
        else if (state.action === 'wait_manage_userid') {
            const uid = text.trim();
            const targetUser = await User.findOne({ id: String(uid) });
            if (!targetUser) { 
                bot.sendMessage(chatId, "❌ *User not found!*", { parse_mode: 'Markdown' }); 
            } else {
                const msgText = `👤 *USER DETAILS*\n\nID: \`${targetUser.id}\`\nName: ${targetUser.first_name}\nUsername: ${targetUser.username}\n\n💰 *Total Bal:* \`${parseFloat(targetUser.balance.toFixed(2))}\` ৳\n\n📊 *Total OTPs:* \`${targetUser.total_otps}\`\n🚫 *Status:* ${targetUser.banned ? '🔴 BANNED' : '🟢 ACTIVE'}`;
                const markup = { inline_keyboard: [[{ text: targetUser.banned ? "✅ Unban User" : "🚫 Ban User", callback_data: `adm_togban_${targetUser.id}` }]]};
                bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup });
            }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_otp_rate') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.per_otp_rate = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *OTP Rate updated to ${val} ৳*`, { parse_mode: 'Markdown' }); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_ref_com') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.ref_otp_commission = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Ref Comm updated to ${val} ৳*`, { parse_mode: 'Markdown' }); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_t1') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.bonus_top1 = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Top 1 updated to ${val} ৳*`, { parse_mode: 'Markdown' }); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_t2') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.bonus_top2 = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Top 2 updated to ${val} ৳*`, { parse_mode: 'Markdown' }); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_t3') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.bonus_top3 = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Top 3 updated to ${val} ৳*`, { parse_mode: 'Markdown' }); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_min_wd') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) { const config = await getAppConfig(); config.min_withdraw = val; await saveAppConfig(config); bot.sendMessage(chatId, `✅ *Min Withdraw updated to ${val} ৳*`, { parse_mode: 'Markdown' }); }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_pay_method_add') {
            const m = text.trim();
            if(m) {
                const config = await getAppConfig(); 
                if(!config.pay_methods.includes(m)) { config.pay_methods.push(m); await saveAppConfig(config); }
                bot.sendMessage(chatId, `✅ *Payment Method '${m}' added!*`, { parse_mode: 'Markdown' });
            }
            delete adminState[chatId]; return;
        }

        // Force Channels & Groups
        else if (state.action === 'wait_force_ch_add' && isMainAdmin(chatId)) {
            const ch = text.trim();
            const config = await getAppConfig();
            if (!config.force_channels.includes(ch)) { config.force_channels.push(ch); await saveAppConfig(config); }
            bot.sendMessage(chatId, `✅ *Force Channel added:* ${ch}`, { parse_mode: 'Markdown' });
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_set_otp_group' && isMainAdmin(chatId)) {
            const config = await getAppConfig(); config.otp_group = text.trim(); await saveAppConfig(config);
            bot.sendMessage(chatId, `✅ OTP Group updated to: ${text.trim()}`);
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_set_pay_group' && isMainAdmin(chatId)) {
            const config = await getAppConfig(); config.payment_group = text.trim(); await saveAppConfig(config);
            bot.sendMessage(chatId, `✅ Payment Group updated to: ${text.trim()}`);
            delete adminState[chatId]; return;
        }
        // 🟢 FIX: Support Username logic
        else if (state.action === 'wait_set_sup_user' && isMainAdmin(chatId)) {
            const config = await getAppConfig(); config.support_user = text.trim(); await saveAppConfig(config);
            bot.sendMessage(chatId, `✅ Support Admin updated to: ${text.trim()}`);
            delete adminState[chatId]; return;
        }
    }

    if (!(await checkForceSub(chatId))) return;

    try {
        if (text === "⚙️ ADMIN SETUP" && isAdmin(chatId)) {
            bot.sendMessage(chatId, "🛠 *Admin Control Panel*\n\nSelect an option below:", { parse_mode: 'Markdown', reply_markup: getAdminMenu(chatId) });
        }
        else if (text === "📲 GET OTP NUMBER") {
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const [plat, countries] of Object.entries(ranges)) {
                if (Object.keys(countries).length > 0) {
                    row.push({ text: `${getPlatIcon(plat)} ${plat.toUpperCase()}`, callback_data: `u_site_${plat}` });
                    if (row.length === 2) { inlineKeyboard.push(row); row = []; }
                }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            if (inlineKeyboard.length === 0) return bot.sendMessage(chatId, "⚠️ *কোনো সাইট বা নাম্বার স্টকে নেই।*", { parse_mode: 'Markdown' });
            bot.sendMessage(chatId, "📌 *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (text === "🌐 LIVE FEED") {
            const config = await getAppConfig();
            bot.sendMessage(chatId, "📡 *Click below to check Live OTP feed:*", { 
                parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [[{ text: "🚀 Go To Live OTP Group", url: `https://t.me/${(config.otp_group||'').replace('@', '')}` }]] } 
            });
        }
        else if (text === "🏆 Top Leaders") {
            const todayStr = getBdDateStr();
            const topUsers = await User.find({ today_otps: { $gt: 0 }, last_active_date: todayStr }).sort({ today_otps: -1 }).limit(10);
            
            let msgText = "🏆 *TODAY'S TOP 10 USERS* 🏆\n\n";
            if (topUsers.length === 0) { msgText += "_No OTPs generated yet today._\n\n"; } 
            else {
                const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
                topUsers.forEach((u, index) => { msgText += `${medals[index] || "🏅"} *${u.first_name}* (ID: \`${u.id}\`)\n🎯 *OTPs:* \`${u.today_otps}\`\n\n`; });
            }
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "👁️ See Your Rank", callback_data: "my_rank" }]] } });
        }
        else if (text === "💸 Refer & Earn") {
            const uData = await ensureUser(msg.from);
            const config = await getAppConfig();
            const refLink = `https://t.me/${botUsername}?start=${uData.id}`;
            const msgText = `🎁 *YOUR REFERRAL SYSTEM*\n\n🔗 *Your Referral Link:*\n\`${refLink}\`\n\n👥 *Total Referred:* \`${uData.referral_count || 0}\` Users\n💰 *Total Earnings:* \`${parseFloat((uData.referral_earnings || 0).toFixed(2))}\` ৳\n\n⚡️ _You get ${config.ref_otp_commission || 0.05} ৳ per successful OTP!_`;
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
        }
        else if (text === "💼 MY ACCOUNT") {
            const uData = await ensureUser(msg.from);
            const config = await getAppConfig();
            let balText = `💰 *Total Balance:* \`${parseFloat(uData.balance.toFixed(2))}\` ৳\n💸 *Today Earnings:* \`${parseFloat(uData.today_balance.toFixed(2))}\` ৳`;
            if (config.reward_system === false) balText = "";

            const msgText = `💼 *USER ACCOUNT*\n\n🔖 *ID:* \`${uData.id}\`\n👤 *Name:* ${uData.first_name}\n\n${balText}\n\n📊 *Total OTPs:* \`${uData.total_otps}\`\n📈 *Today OTPs:* \`${uData.today_otps}\``;
            let markup = { inline_keyboard: [] };
            if (config.reward_system !== false) markup.inline_keyboard.push([{ text: "💵 Withdraw Funds", callback_data: "wd_start" }]);
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup });
        }
        // 🟢 FIX: Support dynamic username
        else if (text === "💬 HELP & SUPPORT") {
            const config = await getAppConfig();
            let supUser = config.support_user || 'admin';
            supUser = supUser.replace('@', ''); // URL friendly
            
            bot.sendMessage(chatId, "🎧 *SUPPORT CENTER*\n\nবট ব্যবহার করতে সমস্যা হলে অ্যাডমিনকে মেসেজ দিন:", { 
                parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [[{ text: "👨‍💻 Contact Support", url: `https://t.me/${supUser}` }]] } 
            });
        }
    } catch (e) {
        bot.sendMessage(chatId, "⚠️ *সার্ভার ত্রুটি!*", { parse_mode: 'Markdown' });
    }
});

// --- Callbacks ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data === "check_joined") {
        const subbed = await isUserSubscribed(chatId);
        if (subbed) {
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            const u = await ensureUser(query.from);
            const welcomeMsg = ` 💐*WELCOME TO PREMIUM FIRE OTP*\n\n👋 Hello, *${u.first_name}*!\n\n🚀 _Get unlimited virtual numbers and instant OTPs for any platform._`;
            bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(chatId) });
        } else { bot.sendMessage(chatId, "⚠️ *আপনি এখনও সবগুলো চ্যানেলে জয়েন করেননি!*", { parse_mode: 'Markdown' }); }
        bot.answerCallbackQuery(query.id).catch(()=>{}); return;
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
            bot.editMessageText("🛠 *Admin Control Panel*\n\nSelect an option below:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getAdminMenu(chatId) }).catch(()=>{});
        }
        
        // 🟢 FIX: User Management Action Support restored
        else if (data === "adm_users" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_manage_userid' }; bot.sendMessage(chatId, "✏️ *Enter User ID to manage:*", { parse_mode: 'Markdown' });
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
        
        // 🟢 FIX: Manage Groups & Support Admin Support
        else if (data === "adm_groups" && isMainAdmin(chatId)) {
            const config = await getAppConfig();
            bot.editMessageText(`🔗 *Manage Groups & Channels*\n\n*OTP Group:* ${config.otp_group}\n*Pay Group:* ${config.payment_group}\n*Support Admin:* ${config.support_user}\n*Force Channels:* ${config.force_channels.length}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
                [{ text: "📢 Manage Force Channels", callback_data: "adm_force_list" }],
                [{ text: "✏️ Set OTP Group", callback_data: "set_otp_grp" }, { text: "✏️ Set Payment Group", callback_data: "set_pay_grp" }],
                [{ text: "🎧 Set Support Admin", callback_data: "set_sup_admin" }],
                [{ text: "🔙 Back", callback_data: "admin_main" }]
            ]}}).catch(()=>{});
        }
        else if (data === "adm_force_list" && isMainAdmin(chatId)) {
            const config = await getAppConfig();
            let kb = [];
            config.force_channels.forEach((ch, idx) => { kb.push([{ text: `🗑️ Remove: ${ch}`, callback_data: `del_force_${idx}` }]); });
            kb.push([{ text: "➕ Add Force Channel", callback_data: "add_force_ch" }]);
            kb.push([{ text: "🔙 Back", callback_data: "adm_groups" }]);
            bot.editMessageText("📢 *Manage Force Channels*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb }}).catch(()=>{});
        }
        else if (data === "add_force_ch" && isMainAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_force_ch_add' };
            bot.sendMessage(chatId, "✏️ Enter Channel username (e.g. @mychannel) or Invite Link:");
        }
        else if (data.startsWith('del_force_') && isMainAdmin(chatId)) {
            const idx = parseInt(data.split('_')[2]);
            const config = await getAppConfig();
            config.force_channels.splice(idx, 1);
            await saveAppConfig(config);
            bot.editMessageText(`✅ Channel Removed!`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_force_list" }]] } }).catch(()=>{});
        }
        else if (data === "set_otp_grp" && isMainAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_set_otp_group' }; bot.sendMessage(chatId, "✏️ Enter OTP Group Link or ID:");
        }
        else if (data === "set_pay_grp" && isMainAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_set_pay_group' }; bot.sendMessage(chatId, "✏️ Enter Payment Group Link or ID:");
        }
        else if (data === "set_sup_admin" && isMainAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_set_sup_user' }; bot.sendMessage(chatId, "✏️ Enter Support Admin Username (e.g. @developer):");
        }
        
        // Sub Admin Balance Logic
        else if (data === "adm_sub_balance" && chatId === SUB_ADMIN_ID) {
            const subDoc = await User.findOne({ id: String(SUB_ADMIN_ID) });
            bot.editMessageText(`💰 *Sub Admin Profit Balance*\n\n💵 *Total Balance:* \`${parseFloat((subDoc.sub_admin_balance||0).toFixed(2))}\` ৳\n\n_Note: You earn a profit margin on every successful OTP._`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
                [{ text: "💸 Withdraw Profit", callback_data: "sub_wd_start" }],
                [{ text: "🔙 Back", callback_data: "admin_main" }]
            ]}}).catch(()=>{});
        }
        else if (data === "sub_wd_start" && chatId === SUB_ADMIN_ID) {
            const config = await getAppConfig();
            let inlineKeyboard = [];
            config.pay_methods.forEach(m => { inlineKeyboard.push([{ text: `💳 ${m}`, callback_data: `subwd_m_${m}` }]); });
            bot.sendMessage(chatId, "📌 *Select Withdrawal Method for Profit:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (data.startsWith('subwd_m_') && chatId === SUB_ADMIN_ID) {
            const method = data.split('subwd_m_')[1];
            userState[chatId] = { action: 'wait_wd_id', method: method, is_sub_admin: true };
            bot.sendMessage(chatId, `✏️ *আপনার ${method} Account ID / Number দিন:*`, { parse_mode: 'Markdown' });
        }

        else if (data === "adm_bot_settings" && isMainAdmin(chatId)) {
            const config = await getAppConfig();
            let kb = [
                [{ text: `⚙️ Server 1: ${config.stexsms_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_stexsms" }],
                [{ text: `⚙️ Server 2: ${config.voltxsms_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_voltxsms" }],
                [{ text: `🚀 Force /start: ${config.force_start ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_forcestart" }],
                [{ text: `🌐 Global Live OTP: ${config.global_feed_on ? "ON 🟢" : "OFF 🔴"}`, callback_data: "tog_globalfeed" }],
                [{ text: "🔙 Back", callback_data: "admin_main" }]
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
            bot.editMessageText("✅ Changed successfully. Open Settings again.", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_bot_settings" }]] } }).catch(()=>{});
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
            bot.editMessageText(dashText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "admin_main" }]] }}).catch(()=>{});
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
            adminState[chatId] = { action: 'wait_broadcast_notice' }; bot.sendMessage(chatId, "✏️ *সব ইউজারদের পাঠানোর জন্য মেসেজটি লিখুন:*", { parse_mode: 'Markdown' });
        }
        
        // 🟢 FIX: Payment Configuration Sub-Menues Restored
        else if (data === "adm_paycfg" && isAdmin(chatId)) {
            const config = await getAppConfig();
            let msg = `💳 *Payment & Reward Settings*\n\n💰 *Per OTP Earning:* \`${config.per_otp_rate}\` ৳\n📉 *Min Withdraw:* \`${config.min_withdraw}\` ৳\n👥 *Ref Comm/OTP:* \`${config.ref_otp_commission || 0.05}\` ৳\n🏆 *Top Bonus:* 1st:\`${config.bonus_top1 || 50}\` | 2nd:\`${config.bonus_top2 || 30}\` | 3rd:\`${config.bonus_top3 || 20}\`\n💳 *Methods:* ${config.pay_methods.join(', ') || 'None'}`;
            let kb = [
                [{ text: `🎁 Reward System: ${config.reward_system ? "ON 🟢" : "OFF 🔴"}`, callback_data: "adm_tog_reward" }],
                [{ text: "✏️ Edit Earning/OTP", callback_data: "adm_edit_otprate" }, { text: "✏️ Ref Comm", callback_data: "adm_edit_refcom" }],
                [{ text: "🥇 Top 1", callback_data: "adm_t1" }, { text: "🥈 Top 2", callback_data: "adm_t2" }, { text: "🥉 Top 3", callback_data: "adm_t3" }],
                [{ text: "✏️ Edit Min Withdraw", callback_data: "adm_edit_minwd" }],
                [{ text: "➕ Add Pay Method", callback_data: "adm_add_paym" }, { text: "🗑️ Del Method", callback_data: "adm_del_paym" }],
                [{ text: "🔙 Back", callback_data: "admin_main" }]
            ];
            bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data === "adm_tog_reward" && isAdmin(chatId)) {
            const config = await getAppConfig(); config.reward_system = !config.reward_system; await saveAppConfig(config);
            bot.editMessageText("✅ Toggled successfully. Re-open to see changes.", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_paycfg" }]] } }).catch(()=>{});
        }
        else if (data === "adm_edit_otprate" && isAdmin(chatId)) { adminState[chatId] = { action: 'wait_otp_rate' }; bot.sendMessage(chatId, "✏️ *Enter new earning per OTP (৳):*", { parse_mode: 'Markdown' }); }
        else if (data === "adm_edit_refcom" && isAdmin(chatId)) { adminState[chatId] = { action: 'wait_ref_com' }; bot.sendMessage(chatId, "✏️ *Enter Referral Commission per OTP (৳):*", { parse_mode: 'Markdown' }); }
        else if (data === "adm_t1" && isAdmin(chatId)) { adminState[chatId] = { action: 'wait_t1' }; bot.sendMessage(chatId, "✏️ *Enter Top 1 Bonus Amount (৳):*", { parse_mode: 'Markdown' }); }
        else if (data === "adm_t2" && isAdmin(chatId)) { adminState[chatId] = { action: 'wait_t2' }; bot.sendMessage(chatId, "✏️ *Enter Top 2 Bonus Amount (৳):*", { parse_mode: 'Markdown' }); }
        else if (data === "adm_t3" && isAdmin(chatId)) { adminState[chatId] = { action: 'wait_t3' }; bot.sendMessage(chatId, "✏️ *Enter Top 3 Bonus Amount (৳):*", { parse_mode: 'Markdown' }); }
        else if (data === "adm_edit_minwd" && isAdmin(chatId)) { adminState[chatId] = { action: 'wait_min_wd' }; bot.sendMessage(chatId, "✏️ *Enter new minimum withdraw limit (৳):*", { parse_mode: 'Markdown' }); }
        else if (data === "adm_add_paym" && isAdmin(chatId)) { adminState[chatId] = { action: 'wait_pay_method_add' }; bot.sendMessage(chatId, "✏️ *Enter new payment method name:*", { parse_mode: 'Markdown' }); }
        else if (data === "adm_del_paym" && isAdmin(chatId)) {
            const config = await getAppConfig();
            let kb = [];
            config.pay_methods.forEach(m => { kb.push([{ text: `🗑️ ${m}`, callback_data: `admdel_m_${m}` }]); });
            kb.push([{ text: "🔙 Back", callback_data: "adm_paycfg" }]);
            bot.editMessageText("📌 *Select method to delete:*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data.startsWith('admdel_m_') && isAdmin(chatId)) {
            const m = data.split('admdel_m_')[1];
            const config = await getAppConfig();
            config.pay_methods = config.pay_methods.filter(x => x !== m);
            await saveAppConfig(config);
            bot.editMessageText(`✅ Deleted '${m}'`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_paycfg" }]] } }).catch(()=>{});
        }

        // 🟢 FIX: Sites and Range flows
        else if (data === "adm_sites" && isAdmin(chatId)) {
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) { inlineKeyboard.push([{ text: `❌ Delete ${getPlatIcon(plat)} ${plat}`, callback_data: `del_site_${plat}` }]); }
            inlineKeyboard.push([{ text: "➕ Add New Site", callback_data: "add_site" }, { text: "🔙 Back", callback_data: "admin_main" }]);
            bot.editMessageText("🌍 *Manage Sites*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data === "add_site" && isAdmin(chatId)) {
            adminState[chatId] = { action: 'wait_site_add' }; 
            bot.sendMessage(chatId, "✏️ নতুন সাইটের নাম দিন (যেমন: Facebook):");
        }
        else if (data.startsWith('del_site_') && isAdmin(chatId)) {
            const plat = data.split('del_site_')[1];
            const ranges = await loadRanges() || {};
            if(ranges[plat]) { delete ranges[plat]; await saveRanges(ranges); }
            bot.editMessageText(`✅ ${plat} ডিলিট করা হয়েছে।`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "adm_sites" }]] } }).catch(()=>{});
        }

        else if (data === "adm_ranges" && isAdmin(chatId)) {
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) { inlineKeyboard.push([{ text: `${getPlatIcon(plat)} ${plat}`, callback_data: `ar_p_${plat}` }]); }
            inlineKeyboard.push([{ text: "🔙 Back", callback_data: "admin_main" }]);
            bot.editMessageText("🔢 *Select Site to Manage Ranges*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_p_') && isAdmin(chatId)) {
            const plat = data.split('_').slice(2).join('_');
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            if (ranges[plat]) {
                for (const country of Object.keys(ranges[plat])) { inlineKeyboard.push([{ text: `🌍 ${country}`, callback_data: `ar_c_${plat}_${country}` }]); }
            }
            inlineKeyboard.push([{ text: "➕ Add Country & Range", callback_data: `ar_add_${plat}` }, { text: "🔙 Back", callback_data: "adm_ranges" }]);
            bot.editMessageText(`🔢 *Manage Countries: ${getPlatIcon(plat)} ${plat}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_add_') && isAdmin(chatId)) {
            const plat = data.split('_').slice(2).join('_');
            adminState[chatId] = { action: 'wait_country_name', platform: plat };
            bot.sendMessage(chatId, "✏️ নতুন কান্ট্রির নাম ও ফ্ল্যাগ দিন (যেমন: 🇧🇩 Bangladesh):");
        }

        // --- Withdraw Controls ---
        else if (data === "wd_start") {
            const config = await getAppConfig();
            if (config.reward_system === false) return bot.sendMessage(chatId, "⚠️ Reward system is currently disabled.");
            let methods = config.pay_methods || [];
            if(methods.length === 0) return bot.sendMessage(chatId, "⚠️ No payment methods available.");
            let inlineKeyboard = [];
            methods.forEach(m => { inlineKeyboard.push([{ text: `💳 ${m}`, callback_data: `wd_m_${m}` }]); });
            bot.sendMessage(chatId, "📌 *Select Payment Method:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (data.startsWith('wd_m_')) {
            const method = data.split('wd_m_')[1];
            userState[chatId] = { action: 'wait_wd_id', method: method };
            bot.sendMessage(chatId, `✏️ *আপনার ${method} Account ID / Number দিন:*`, { parse_mode: 'Markdown' });
        }

        // Fast Number Flow
        else if (data.startsWith('u_site_')) {
            const plat = data.split('_').slice(2).join('_');
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const country of Object.keys(ranges[plat] || {})) {
                row.push({ text: country, callback_data: `u_cntry_${plat}_${country}` });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            bot.editMessageText(`📌 *Select Country for ${getPlatIcon(plat)} ${plat.toUpperCase()}:*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('u_cntry_')) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            await generateNewNumber(chatId, plat, country, null, null, null);
        }
        else if (data.startsWith('change_')) {
            const num = data.split('_')[1];
            const session = activeNumbers.get(num);
            if (session && session.chatId === chatId) {
                const { plat, country, panel, range } = session;
                activeNumbers.delete(num);
                bot.editMessageText("❌ *Number Cancelled. Generating New...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                await generateNewNumber(chatId, plat, country, panel, range, msgId);
            } else { bot.editMessageText("❌ *Session Expired.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{}); }
        }
        else if (data === "get_new_num") {
            const lastSession = userLastSession.get(chatId);
            if (lastSession) {
                bot.sendMessage(chatId, "🚀 *Generating requested number...*", {parse_mode: 'Markdown'}).then(sentMsg => {
                    generateNewNumber(chatId, lastSession.plat, lastSession.country, lastSession.panel, lastSession.range, sentMsg.message_id);
                });
            }
        }
    } catch(e) { }
});

Promise.all([loadPanelKeys()]).then(() => console.log("🔑 Settings Loaded. UI/UX Polished. Fixes applied."));
