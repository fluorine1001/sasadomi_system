import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import admin from 'firebase-admin';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import axios from 'axios';
import * as cheerio from 'cheerio';
import 'dotenv/config';

const app = express();

app.use(cors({
    origin: '*',
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json());

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        })
    });
}
const db = admin.firestore();

const verifyApiKey = async (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ success: false, message: 'API Key가 누락되었습니다.' });
    try {
        const keyDoc = await db.collection('api_keys').doc(apiKey).get();
        if (!keyDoc.exists) return res.status(403).json({ success: false, message: '유효하지 않은 API Key입니다.' });
        next();
    } catch (error) {
        return res.status(500).json({ success: false, message: '인증 서버 오류' });
    }
};

app.get('/', (req, res) => {
    res.send('🚀 Sasadomi System Public API Hub is running perfectly!');
});

const ENCRYPTION_KEY = process.env.SECRET_KEY || 'a'.repeat(32); 
const IV_LENGTH = 16;

function encrypt(text) {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) throw new Error("복호화할 텍스트가 없습니다.");
    let textParts = text.split(':');
    let iv = Buffer.from(textParts.shift(), 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]); 
    return decrypted.toString();
}

const SCHOOL_BASE_URL = 'https://sasadomi.hs.kr';

async function getAuthenticatedSession(studentId, rawPassword) {
    const jar = new CookieJar();
    const client = wrapper(axios.create({ 
        jar, 
        withCredentials: true,
        timeout: 7000,
        validateStatus: () => true 
    }));

    const loginRes = await client.post(`${SCHOOL_BASE_URL}/Lib/user.action.php`, new URLSearchParams({
        mode: 'login',
        id: studentId,
        pw: rawPassword
    }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (loginRes.status !== 200) {
        throw new Error(`학교 로그인 페이지 접속 실패 (HTTP 상태코드: ${loginRes.status})`);
    }

    return client;
}

function parseTable(html) {
    const $ = cheerio.load(html);
    const list = [];
    // 상벌점 테이블 파싱 안정성을 위해 tbody 선택자 제거 가능성 열어둠
    $('table.table-hover tr').each((index, element) => {
        const tds = $(element).find('td');
        if (tds.length >= 4) {
            list.push({
                score: tds.eq(0).text().trim(),
                weight: tds.eq(1).text().trim(),
                reason: tds.eq(2).clone().children().remove().end().text().trim(),
                date: tds.eq(3).text().trim()
            });
        }
    });
    return list;
}

// [API 1] 로그인 정보 저장 및 상벌점 스크래핑
app.post('/api/login-and-fetch', verifyApiKey, async (req, res) => {
    const { studentId, studentPw, grade, sclass, number } = req.body;
    try {
        const client = await getAuthenticatedSession(studentId, studentPw);
        const encryptedPw = encrypt(studentPw);
        
        await db.collection('users').doc(studentId).set({
            studentId, encryptedPw, grade, class: sclass, number,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const sessionToken = crypto.randomUUID();
        await db.collection('sessions').doc(sessionToken).set({
            studentId: studentId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const rewardResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=1`);
        const $reward = cheerio.load(rewardResponse.data);
        let rewardText = $reward('#rewordTab p').eq(1).text() || '0';
        const totalReward = rewardText.replace(/[^0-9]/g, '') || '0';
        const rewardList = parseTable(rewardResponse.data);

        const penaltyResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=2`);
        const $penalty = cheerio.load(penaltyResponse.data);
        let penaltyText = $penalty('#punishmentTab p').eq(1).text() || '0';
        const totalPenalty = penaltyText.replace(/[^0-9]/g, '') || '0';
        const penaltyList = parseTable(penaltyResponse.data);

        res.json({ success: true, sessionToken, totalReward, totalPenalty, rewardList, penaltyList });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: `로그인/연동 중 오류: ${error.message}` });
    }
});

// [API] 자동 로그인
app.post('/api/auto-login', verifyApiKey, async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(401).json({ success: false, message: '토큰 없음' });
    try {
        const sessionDoc = await db.collection('sessions').doc(token).get();
        if (!sessionDoc.exists) return res.status(401).json({ success: false, message: '만료된 세션' });

        const { studentId } = sessionDoc.data();
        const userDoc = await db.collection('users').doc(studentId).get();
        if (!userDoc.exists) return res.status(404).json({ success: false, message: '유저 데이터 없음' });

        const userData = userDoc.data();
        const rawPassword = decrypt(userData.encryptedPw);
        const client = await getAuthenticatedSession(studentId, rawPassword);
        
        const rewardResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=1`);
        const $reward = cheerio.load(rewardResponse.data);
        const totalReward = ($reward('#rewordTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0';
        const rewardList = parseTable(rewardResponse.data);

        const penaltyResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=2`);
        const $penalty = cheerio.load(penaltyResponse.data);
        const totalPenalty = ($penalty('#punishmentTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0';
        const penaltyList = parseTable(penaltyResponse.data);

        res.json({ success: true, studentId, totalReward, totalPenalty, rewardList, penaltyList });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: `자동 로그인 오류: ${error.message}` });
    }
});

// [API 2] 자율학습 신청 대행
app.post('/api/apply-study', verifyApiKey, async (req, res) => {
    const { studentId, token, date, time, place, detail, detail_reason } = req.body;
    if (!token) return res.status(401).json({ success: false, message: '인증 토큰이 누락되었습니다.' });

    try {
        const sessionDoc = await db.collection('sessions').doc(token).get();
        if (!sessionDoc.exists || sessionDoc.data().studentId !== studentId) {
            return res.status(401).json({ success: false, message: '유효하지 않거나 만료된 권한입니다.' });
        }

        const userDoc = await db.collection('users').doc(studentId).get();
        if (!userDoc.exists) return res.status(404).json({ message: '등록된 유저 정보가 없습니다.' });
        
        const userData = userDoc.data();
        const rawPassword = decrypt(userData.encryptedPw);
        const client = await getAuthenticatedSession(studentId, rawPassword);

        const params = new URLSearchParams({
            mode: 'apply', reason: '1',
            grade: userData.grade || '', class: userData.class || '', class_number: userData.number || '',
            date: date, time: time, place: place,
            detail: detail || '', detail_reason: detail_reason || ''
        });

        const response = await client.post(`${SCHOOL_BASE_URL}/Lib/study_apply.action.php`, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            validateStatus: () => true 
        });

        const responseText = typeof response.data === 'string' 
            ? response.data 
            : JSON.stringify(response.data);

        if (responseText.includes('history.back') || responseText.includes('alert(') || responseText.includes('실패')) {
            return res.status(400).json({ success: false, message: '학교 시스템에서 처리를 거부했습니다. (이미 신청됨 혹은 신청 기간 아님)' });
        }

        res.json({ success: true, message: '자율학습 신청 완료' });
    } catch (error) {
        console.error("자율학습 신청 에러 디테일:", error);
        res.status(500).json({ success: false, message: `자율학습 신청 내부 서버 에러: ${error.message}` });
    }
});

// [API 3] 외출/외박 신청 대행
app.post('/api/apply-out', verifyApiKey, async (req, res) => {
    const { studentId, token, type, reason, bdate, edate } = req.body;
    if (!token) return res.status(401).json({ success: false, message: '인증 토큰이 누락되었습니다.' });

    try {
        const sessionDoc = await db.collection('sessions').doc(token).get();
        if (!sessionDoc.exists || sessionDoc.data().studentId !== studentId) {
            return res.status(401).json({ success: false, message: '유효하지 않거나 만료된 권한입니다.' });
        }

        const userDoc = await db.collection('users').doc(studentId).get();
        if (!userDoc.exists) return res.status(404).json({ message: '등록된 유저 정보가 없습니다.' });
        
        const userData = userDoc.data();
        const rawPassword = decrypt(userData.encryptedPw);
        const client = await getAuthenticatedSession(studentId, rawPassword);

        const params = new URLSearchParams({
            mode: 'apply',
            grade: userData.grade || '', class: userData.class || '', class_number: userData.number || '',
            type: type, reason: reason, bdate: bdate, edate: edate
        });

        const response = await client.post(`${SCHOOL_BASE_URL}/Lib/school_out.action.php`, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            validateStatus: () => true
        });

        const responseText = typeof response.data === 'string' 
            ? response.data 
            : JSON.stringify(response.data);

        if (responseText.includes('history.back') || responseText.includes('alert(') || responseText.includes('실패')) {
            return res.status(400).json({ success: false, message: '학교 시스템에서 외출 처리를 거부했습니다.' });
        }

        res.json({ success: true, message: '외출/외박 신청 완료' });
    } catch (error) {
        console.error("외출 신청 에러 디테일:", error);
        res.status(500).json({ success: false, message: `외출/외박 신청 내부 서버 에러: ${error.message}` });
    }
});

// [API 4] 계정 연동 해제
app.post('/api/disconnect', verifyApiKey, async (req, res) => {
    const { studentId, token } = req.body;
    if (!studentId) return res.status(400).json({ success: false, message: '학번이 필요합니다.' });
    try {
        await db.collection('users').doc(studentId).delete();
        if (token) await db.collection('sessions').doc(token).delete();
        res.json({ success: true, message: '계정 연동이 안전하게 해제되었습니다.' });
    } catch (error) {
        res.status(500).json({ success: false, message: `연동 해제 중 에러: ${error.message}` });
    }
});

// [API 5] 신청 내역(자율학습, 외출/외박) 조회
app.post('/api/fetch-applications', verifyApiKey, async (req, res) => {
    const { studentId, token } = req.body;
    if (!token) return res.status(401).json({ success: false, message: '인증 토큰이 누락되었습니다.' });

    try {
        const sessionDoc = await db.collection('sessions').doc(token).get();
        if (!sessionDoc.exists || sessionDoc.data().studentId !== studentId) {
            return res.status(401).json({ success: false, message: '유효하지 않거나 만료된 권한입니다.' });
        }

        const userDoc = await db.collection('users').doc(studentId).get();
        if (!userDoc.exists) return res.status(404).json({ message: '등록된 유저 정보가 없습니다.' });
        
        const userData = userDoc.data();
        const rawPassword = decrypt(userData.encryptedPw);
        const client = await getAuthenticatedSession(studentId, rawPassword);

        // 1. 자율학습 신청 내역 파싱
        const studyRes = await client.get(`${SCHOOL_BASE_URL}/study/apply.php`);
        const $study = cheerio.load(studyRes.data);
        const studyList = [];
        
        // 브라우저 보정 버그를 유발하는 tbody 제거 및 데이터 안전 정제 적용
        $study('table tr').each((i, el) => {
            const tds = $study(el).find('td');
            if (tds.length > 0 && !tds.eq(0).text().includes('없습니다')) {
                studyList.push({
                    date: tds.eq(0).text().trim(),
                    time: tds.eq(1).text().trim(),
                    place: tds.eq(2).text().trim(),
                    detail: tds.eq(3).text().trim(),
                    status: tds.last().text().trim().replace(/\s+/g, ' ')
                });
            }
        });

        // 2. 외출/외박 신청 내역 파싱
        const outRes = await client.get(`${SCHOOL_BASE_URL}/school_out/apply.php`);
        const $out = cheerio.load(outRes.data);
        const outList = [];
        
        // 동일하게 tbody 제거 및 안전 정제 적용
        $out('table tr').each((i, el) => {
            const tds = $out(el).find('td');
            if (tds.length > 0 && !tds.eq(0).text().includes('없습니다')) {
                outList.push({
                    type: tds.eq(0).text().trim(),
                    reason: tds.eq(1).text().trim(),
                    outDate: tds.eq(2).text().trim(),
                    inDate: tds.eq(3).text().trim(),
                    status: tds.last().text().trim().replace(/\s+/g, ' ')
                });
            }
        });

        res.json({ success: true, studyList, outList });
    } catch (error) {
        console.error("내역 조회 에러:", error);
        res.status(500).json({ success: false, message: `내역 조회 중 서버 에러: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`공용 오픈 API 서버 작동 중 :: 포트 ${PORT}`));
