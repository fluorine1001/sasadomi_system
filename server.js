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

// 1. Firebase Admin 초기화 (Codespaces 환경변수나 JSON 파일 연동)
// 실제 사용 시 Firebase에서 다운로드한 서비스 계정 키 설정을 채워주세요.
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
const ENCRYPTION_KEY = process.env.SECRET_KEY || 'a'.repeat(32); // 32바이트 키 필요
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

// 🏫 학교 사이트 베이스 주소 정의 (실제 도메인으로 변경하여 사용)
const SCHOOL_BASE_URL = 'https://sasadomi.hs.kr';

// 공통 함수: 학교 세션 로그인 후 Axios 인스턴스 반환
async function getAuthenticatedSession(studentId, rawPassword) {
    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));

    // 로그인 요청
    await client.post(`${SCHOOL_BASE_URL}/Lib/user.action.php`, new URLSearchParams({
        mode: 'login',
        id: studentId,
        pw: rawPassword
    }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    return client;
}

// [API 1] 로그인 정보 저장 및 상벌점 총점/내역 스크래핑
app.post('/api/login-and-fetch', async (req, res) => {
    const { studentId, studentPw, grade, sclass, number } = req.body;

    try {
        // 1. 학교 사이트 로그인 검증 시도
        const client = await getAuthenticatedSession(studentId, studentPw);

        // 2. 검증 성공 시 Firebase Firestore에 암호화하여 사용자 정보 저장/업데이트
        const encryptedPw = encrypt(studentPw);
        await db.collection('users').doc(studentId).set({
            studentId,
            encryptedPw,
            grade,
            class: sclass,
            number,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // 3. 마이페이지 화면 데이터 가져오기 (실제 벌점조회 주소 입력)
        const response = await client.get(`${SCHOOL_BASE_URL}/point/list.php`); 
        const $ = cheerio.load(response.data);

        // 총점 파싱
        let rewardText = $('#rewordTab p').eq(1).text() || '0';
        let penaltyText = $('#punishmentTab p').eq(1).text() || '0';
        const totalReward = rewardText.replace(/[^0-9]/g, '');
        const totalPenalty = penaltyText.replace(/[^0-9]/g, '');

        // 세부 내역 파싱
        let historyList = [];
        $('table.table-hover tbody tr').each((index, element) => {
            const tds = $(element).find('td');
            if (tds.length > 0) {
                historyList.push({
                    score: $(tds[0]).text().trim(),
                    weight: $(tds[1]).text().trim(),
                    reason: $(tds[2]).clone().children().remove().end().text().trim(),
                    date: $(tds[3]).text().trim()
                });
            }
        });

        res.json({ success: true, totalReward, totalPenalty, historyList });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '로그인 실패 또는 데이터 파싱 오류' });
    }
});

// [API 2] 자율학습 신청 대행
app.post('/api/apply-study', async (req, res) => {
    const { studentId, date, time, place, detail, detail_reason } = req.body;

    try {
        // DB에서 암호화된 비밀번호 및 학생 정보 조회
        const userDoc = await db.collection('users').doc(studentId).get();
        if (!userDoc.exists) return res.status(404).json({ message: '등록된 유저 정보가 없습니다.' });
        
        const userData = userDoc.data();
        const rawPassword = decrypt(userData.encryptedPw);

        // 학교 세션 획득
        const client = await getAuthenticatedSession(studentId, rawPassword);

        // 학교 포맷 데이터 구성 (요청 파라미터 규격 적용)
        const params = new URLSearchParams({
            mode: 'apply',
            reason: '1',
            grade: userData.grade,
            class: userData.class,
            class_number: userData.number,
            date: date, // 프론트엔드에서 계산된 초 단위 타임스탬프
            time: time,
            place: place,
            detail: detail || '',         // 지도교사 (본관 선택 시 필수)
            detail_reason: detail_reason || '' // 사유 (본관 선택 시 필수)
        });

        const response = await client.post(`${SCHOOL_BASE_URL}/Lib/study_apply.action.php`, params.toString(), {
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
            type: type,      // 1: 외출, 2: 외박
            reason: reason,  // 사유 필수
            bdate: bdate,    // 출발 타임스탬프 (초)
            edate: edate     // 복귀 타임스탬프 (초)
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 작동 중 :: 포트 ${PORT}`));
