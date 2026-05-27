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
    origin: '*', // 추후 미들웨어에서 제어하므로 Express 단에서는 우선 열어둡니다.
    methods: ['POST', 'GET', 'OPTIONS', 'DELETE', 'PUT'],
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

// 🟢 [Step 1] 동적 API Key 및 도메인 검증 미들웨어
const verifyDeveloperApiKey = async (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ success: false, message: 'API Key가 누락되었습니다.' });
    
    try {
        // developers 컬렉션에서 서드파티 개발자 정보 조회
        const keyDoc = await db.collection('developers').doc(apiKey).get();
        if (!keyDoc.exists) {
            return res.status(403).json({ success: false, message: '유효하지 않은 API Key입니다.' });
        }

        const devData = keyDoc.data();

        // 계정 활성화 상태 검증
        if (devData.isActive === false) {
            return res.status(403).json({ success: false, message: '사용이 정지된 API Key입니다.' });
        }

        // 도메인 화이트리스트 검증 (브라우저 요청일 경우)
        const origin = req.headers.origin;
        const allowedDomains = devData.allowedDomains || [];
        if (origin && allowedDomains.length > 0 && !allowedDomains.includes(origin)) {
            return res.status(403).json({ success: false, message: `허용되지 않은 도메인(${origin})에서의 접근입니다.` });
        }

        // 통과 시 req 객체에 개발자 정보 세팅
        req.developer = devData;
        next();
    } catch (error) {
        console.error('API Key 검증 오류:', error);
        return res.status(500).json({ success: false, message: '인증 서버 내부 오류' });
    }
};

app.get('/', (req, res) => {
    res.send('🚀 Sasadomi System Public API Hub (v1) is running perfectly!');
});

// --- 암복호화 및 스크래핑 유틸리티 ---
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

// 🟢 [Step 2] RESTful API 버전 1 라우터 생성
const v1Router = express.Router();
v1Router.use(verifyDeveloperApiKey); // v1 하위 모든 요청에 미들웨어 적용

// ---------------------------------------------
// 1. 인증(Auth) 관련 엔드포인트
// ---------------------------------------------
v1Router.post('/auth/login', async (req, res) => {
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
        const totalReward = ($reward('#rewordTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0';
        const rewardList = parseTable(rewardResponse.data);

        const penaltyResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=2`);
        const $penalty = cheerio.load(penaltyResponse.data);
        const totalPenalty = ($penalty('#punishmentTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0';
        const penaltyList = parseTable(penaltyResponse.data);

        res.json({ success: true, sessionToken, totalReward, totalPenalty, rewardList, penaltyList });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: `로그인/연동 중 오류: ${error.message}` });
    }
});

v1Router.post('/auth/auto-login', async (req, res) => {
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

v1Router.post('/auth/disconnect', async (req, res) => {
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

// ---------------------------------------------
// 2. 내역 조회 및 신청(Applications) 엔드포인트
// ---------------------------------------------
// GET 메서드로 변경. Query 파라미터 활용 (?studentId=...&token=...)
v1Router.get('/applications', async (req, res) => {
    const { studentId, token } = req.query; 
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

        const studyRes = await client.get(`${SCHOOL_BASE_URL}/study/list.php`);
        const $study = cheerio.load(studyRes.data);
        const studyList = [];
        
        $study('table.table.table-hover tbody tr').each((i, el) => {
            const tds = $study(el).find('td');
            if (tds.length >= 7 && !tds.eq(0).text().includes('없습니다')) {
                const id = tds.eq(0).find('input[type=checkbox]').val() || '';
                studyList.push({
                    id: id,
                    date: tds.eq(2).text().trim(),
                    time: tds.eq(3).text().trim(),
                    place: tds.eq(4).text().trim(),
                    detail: tds.eq(5).text().trim(),
                    status: tds.last().text().trim() || '대기'
                });
            }
        });

        const outRes = await client.get(`${SCHOOL_BASE_URL}/out/list.php`);
        const $out = cheerio.load(outRes.data);
        const outList = [];
        
        $out('table.table.table-hover tbody tr').each((i, el) => {
            const tds = $out(el).find('td');
            if (tds.length >= 7 && !tds.eq(0).text().includes('없습니다')) {
                const id = tds.eq(0).find('input[name=itemCheck]').val() || '';
                const type = tds.eq(2).text().trim();
                const timeText = tds.eq(3).text().replace(/\s+/g, ' ').trim(); 
                
                const timeParts = timeText.split('-').map(t => t.trim());
                outList.push({
                    id: id,
                    type: type,
                    reason: tds.eq(4).text().trim(),
                    outDate: timeParts[0] || '',
                    inDate: timeParts[1] || '',
                    status: tds.eq(6).text().trim() || '대기'
                });
            }
        });

        res.json({ success: true, studyList, outList });
    } catch (error) {
        console.error("내역 조회 에러:", error);
        res.status(500).json({ success: false, message: `내역 조회 중 서버 에러: ${error.message}` });
    }
});

v1Router.post('/applications/study', async (req, res) => {
    const { studentId, token, date, time, place, detail, detail_reason } = req.body;
    if (!token) return res.status(401).json({ success: false, message: '인증 토큰 누락' });
    // ... 세션 조회, getAuthenticatedSession 등 (중략 방지: 아래 로직 그대로)
    try {
        const sessionDoc = await db.collection('sessions').doc(token).get();
        if (!sessionDoc.exists || sessionDoc.data().studentId !== studentId) {
            return res.status(401).json({ success: false, message: '권한 없음' });
        }
        const userDoc = await db.collection('users').doc(studentId).get();
        const userData = userDoc.data();
        const client = await getAuthenticatedSession(studentId, decrypt(userData.encryptedPw));

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

        const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        if (responseText.includes('history.back') || responseText.includes('실패')) {
            return res.status(400).json({ success: false, message: '신청 기간 아님 / 이미 신청됨' });
        }
        res.status(201).json({ success: true, message: '신청 완료' });
    } catch (error) {
        res.status(500).json({ success: false, message: `서버 에러: ${error.message}` });
    }
});

v1Router.post('/applications/out', async (req, res) => {
    const { studentId, token, type, reason, bdate, edate } = req.body;
    if (!token) return res.status(401).json({ success: false, message: '인증 토큰 누락' });
    try {
        const sessionDoc = await db.collection('sessions').doc(token).get();
        if (!sessionDoc.exists || sessionDoc.data().studentId !== studentId) {
            return res.status(401).json({ success: false, message: '권한 없음' });
        }
        const userDoc = await db.collection('users').doc(studentId).get();
        const userData = userDoc.data();
        const client = await getAuthenticatedSession(studentId, decrypt(userData.encryptedPw));

        const params = new URLSearchParams({
            mode: 'apply',
            grade: userData.grade || '', class: userData.class || '', class_number: userData.number || '',
            type: type, reason: reason, bdate: bdate, edate: edate
        });

        const response = await client.post(`${SCHOOL_BASE_URL}/Lib/school_out.action.php`, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            validateStatus: () => true
        });

        const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        if (responseText.includes('history.back') || responseText.includes('실패')) {
            return res.status(400).json({ success: false, message: '외출 처리가 거부됨' });
        }
        res.status(201).json({ success: true, message: '외출/외박 신청 완료' });
    } catch (error) {
        res.status(500).json({ success: false, message: `서버 에러: ${error.message}` });
    }
});

// DELETE 메서드 적용 (Params 활용: /v1/applications/out/1234)
v1Router.delete('/applications/:type/:id', async (req, res) => {
    const { type, id } = req.params;
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
        const client = await getAuthenticatedSession(studentId, decrypt(userData.encryptedPw));

        const actionUrl = type === 'out' 
            ? `${SCHOOL_BASE_URL}/Lib/school_out.action.php` 
            : `${SCHOOL_BASE_URL}/Lib/study_apply.action.php`;

        const params = new URLSearchParams({ mode: 'apply_del', del_items: id });

        const response = await client.post(actionUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        if (responseText.includes('PERM_ERR')) return res.status(403).json({ success: false, message: '권한 없음' });
        if (responseText.includes('CHANGED_STATE_EXIST')) return res.status(400).json({ success: false, message: '변경 불가 상태' });
        if (responseText.includes('실패')) return res.status(400).json({ success: false, message: '삭제 실패' });

        res.json({ success: true, message: '정상 취소됨' });
    } catch (error) {
        res.status(500).json({ success: false, message: `서버 오류: ${error.message}` });
    }
});

// 메인 앱에 v1 라우터 결합
app.use('/v1', v1Router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sasadomi API (v1) 구동 중 :: 포트 ${PORT}`));
