const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
app.use(cors());
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

// 🏫 학교 사이트 베이스 주소 정의
const SCHOOL_BASE_URL = 'https://sasadomi.hs.kr';

// 공통 함수: 학교 세션 로그인 후 Axios 인스턴스 반환
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

// 공통 함수: HTML에서 표(테이블) 데이터를 배열로 추출
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

// [API 1] 로그인 정보 저장 및 상벌점 총점/내역 스크래핑
app.post('/api/login-and-fetch', async (req, res) => {
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

        // 💡 추가됨: 고유 세션 토큰 생성 및 DB 저장
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
            sessionToken, // 프론트로 토큰 전달
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

// 📌 [새로운 API] 토큰을 이용한 자동 로그인
app.post('/api/auto-login', async (req, res) => {
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

        // 복호화된 비번으로 학교 사이트 접속 후 실시간 데이터 로드
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
app.post('/api/apply-study', async (req, res) => {
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
app.post('/api/apply-out', async (req, res) => {
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

// 📌 [API 4] 계정 연동 해제 (Firestore에서 학생 정보 완전 삭제 및 토큰 파기)
app.post('/api/disconnect', async (req, res) => {
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

        // DB에서 학생 계정 문서 삭제
        await userRef.delete();

        // 전달받은 세션 토큰이 있다면 DB에서 해당 토큰 무효화(삭제)
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
app.listen(PORT, () => console.log(`서버 작동 중 :: 포트 ${PORT}`));
