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

// 🟢 [변경] 모든 도메인 및 외부 클라이언트에서 이 API를 호출할 수 있도록 CORS 전면 개방
app.use(cors({
    origin: '*',
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'] // x-api-key 헤더 허용
}));
app.use(express.json());

// 1. Firebase Admin 초기화
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

// 🟢 [신규] 외부 개발자 인증을 위한 API Key 검증 미들웨어
const verifyApiKey = async (req, res, next) => {
    // OPTIONS(CORS 예비 요청)는 인증을 건너뜁니다.
    if (req.method === 'OPTIONS') return next();

    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
        return res.status(401).json({ success: false, message: 'API Key (x-api-key)가 헤더에 누락되었습니다.' });
    }

    try {
        // Firebase의 api_keys 컬렉션에서 해당 키가 존재하는지 확인
        const keyDoc = await db.collection('api_keys').doc(apiKey).get();
        if (!keyDoc.exists) {
            return res.status(403).json({ success: false, message: '등록되지 않았거나 유효하지 않은 API Key입니다.' });
        }
        next(); // 인증 통과 시 다음 로직 실행
    } catch (error) {
        console.error('API Key 검증 오류:', error);
        return res.status(500).json({ success: false, message: '인증 서버 오류' });
    }
};

// 기본 주소 접속 시 서버 상태 확인 (인증 제외)
app.get('/', (req, res) => {
    res.send('🚀 Sasadomi System Public API Hub is running perfectly!');
});

// 2. 비밀번호 암호화/복호화 설정 (AES-256-CBC)
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
    const client = wrapper(axios.create({ jar, withCredentials: true }));

    await client.post(`${SCHOOL_BASE_URL}/Lib/user.action.php`, new URLSearchParams({
        mode: 'login',
        id: studentId,
        pw: rawPassword
    }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return client;
}

function parseTable(html) {
    const $ = cheerio.load(html);
    const list = [];
    $('table.table-hover tbody tr').each((index, element) => {
        const tds = $(element).find('td');
        if (tds.length >= 4) {
            list.push({
                score: $(tds[0]).text().trim(),
                weight: $(tds[1]).text().trim(),
                reason: $(tds[2]).clone().children().remove().end().text().trim(),
                date: $(tds[3]).text().trim()
            });
        }
    });
    return list;
}

// 🟢 아래 핵심 기능들에는 모두 verifyApiKey 미들웨어를 장착하여 보호합니다.

// [API 1] 로그인 정보 저장 및 상벌점 총점/내역 스크래핑
app.post('/api/login-and-fetch', verifyApiKey, async (req, res) => {
    const { studentId, studentPw, grade, sclass, number } = req.body;

    try {
        const client = await getAuthenticatedSession(studentId, studentPw);

        const encryptedPw = encrypt(studentPw);
        await db.collection('users').doc(studentId).set({
            studentId,
            encryptedPw,
            grade,
            class: sclass,
            number,
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
        let penaltyText = $reward('#punishmentTab p').eq(1).text() || '0';
        const totalReward = rewardText.replace(/[^0-9]/g, '');
        const totalPenalty = penaltyText.replace(/[^0-9]/g, '');

        const rewardList = parseTable(rewardResponse.data);

        const penaltyResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=2`);
        const penaltyList = parseTable(penaltyResponse.data);

        res.json({ 
            success: true, 
            sessionToken, 
            totalReward, 
            totalPenalty, 
            rewardList, 
            penaltyList 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '로그인 실패 또는 데이터 파싱 오류' });
    }
});

// [API] 토큰을 이용한 자동 로그인
app.post('/api/auto-login', verifyApiKey, async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(401).json({ success: false, message: '토큰 없음' });

    try {
        const sessionDoc = await db.collection('sessions').doc(token).get();
        if (!sessionDoc.exists) {
            return res.status(401).json({ success: false, message: '유효하지 않거나 만료된 세션' });
        }

        const { studentId } = sessionDoc.data();
        const userDoc = await db.collection('users').doc(studentId).get();
        
        if (!userDoc.exists) return res.status(404).json({ success: false, message: '학생 데이터 없음' });

        const userData = userDoc.data();
        const rawPassword = decrypt(userData.encryptedPw);

        const client = await getAuthenticatedSession(studentId, rawPassword);
        
        const rewardResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=1`);
        const $reward = cheerio.load(rewardResponse.data);
        let rewardText = $reward('#rewordTab p').eq(1).text() || '0';
        let penaltyText = $reward('#punishmentTab p').eq(1).text() || '0';
        const totalReward = rewardText.replace(/[^0-9]/g, '');
        const totalPenalty = penaltyText.replace(/[^0-9]/g, '');

        const rewardList = parseTable(rewardResponse.data);
        const penaltyResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=2`);
        const penaltyList = parseTable(penaltyResponse.data);

        res.json({
            success: true,
            studentId,
            totalReward, 
            totalPenalty, 
            rewardList, 
            penaltyList
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '자동 로그인 처리 오류' });
    }
});

// [API 2] 자율학습 신청 대행
app.post('/api/apply-study', verifyApiKey, async (req, res) => {
    const { studentId, date, time, place, detail, detail_reason } = req.body;

    try {
        const userDoc = await db.collection('users').doc(studentId).get();
        if (!userDoc.exists) return res.status(404).json({ message: '등록된 유저 정보가 없습니다.' });
        
        const userData = userDoc.data();
        const rawPassword = decrypt(userData.encryptedPw);

        const client = await getAuthenticatedSession(studentId, rawPassword);

        const params = new URLSearchParams({
            mode: 'apply',
            reason: '1',
            grade: userData.grade,
            class: userData.class,
            class_number: userData.number,
            date: date,
            time: time,
            place: place,
            detail: detail || '',
            detail_reason: detail_reason || ''
        });

        await client.post(`${SCHOOL_BASE_URL}/Lib/study_apply.action.php`, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        res.json({ success: true, message: '자율학습 신청 완료' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '자율학습 신청 중 서버 오류 발생' });
    }
});

// [API 3] 외출/외박 신청 대행
app.post('/api/apply-out', verifyApiKey, async (req, res) => {
    const { studentId, type, reason, bdate, edate } = req.body;

    try {
        const userDoc = await db.collection('users').doc(studentId).get();
        if (!userDoc.exists) return res.status(404).json({ message: '등록된 유저 정보가 없습니다.' });
        
        const userData = userDoc.data();
        const rawPassword = decrypt(userData.encryptedPw);

        const client = await getAuthenticatedSession(studentId, rawPassword);

        const params = new URLSearchParams({
            mode: 'apply',
            grade: userData.grade,
            class: userData.class,
            class_number: userData.number,
            type: type,
            reason: reason,
            bdate: bdate,
            edate: edate
        });

        await client.post(`${SCHOOL_BASE_URL}/Lib/school_out.action.php`, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        res.json({ success: true, message: '외출/외박 신청 완료' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '외출/외박 신청 중 오류 발생' });
    }
});

// [API 4] 계정 연동 해제
app.post('/api/disconnect', verifyApiKey, async (req, res) => {
    const { studentId, token } = req.body;

    if (!studentId) {
        return res.status(400).json({ success: false, message: '학번이 필요합니다.' });
    }

    try {
        const userRef = db.collection('users').doc(studentId);
        const doc = await userRef.get();

        if (!doc.exists) {
            return res.status(404).json({ success: false, message: '연동된 계정 정보가 존재하지 않습니다.' });
        }

        await userRef.delete();

        if (token) {
            await db.collection('sessions').doc(token).delete();
        }

        res.json({ success: true, message: '계정 연동이 안전하게 해제되었습니다.' });
    } catch (error) {
        console.error('연동 해제 오류:', error);
        res.status(500).json({ success: false, message: '연동 해제 중 서버 오류가 발생했습니다.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`공용 오픈 API 서버 작동 중 :: 포트 ${PORT}`));
