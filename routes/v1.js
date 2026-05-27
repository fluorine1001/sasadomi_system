import express from 'express';
import crypto from 'crypto';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import axios from 'axios';
import * as cheerio from 'cheerio';

const SCHOOL_BASE_URL = 'https://sasadomi.hs.kr';
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

async function getAuthenticatedSession(studentId, rawPassword) {
    const jar = new CookieJar();
    const client = wrapper(axios.create({ 
        jar, withCredentials: true, timeout: 7000, validateStatus: () => true 
    }));
    const loginRes = await client.post(`${SCHOOL_BASE_URL}/Lib/user.action.php`, new URLSearchParams({
        mode: 'login', id: studentId, pw: rawPassword
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (loginRes.status !== 200) throw new Error(`학교 로그인 페이지 접속 실패`);
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

// 🟢 라우터 생성 함수 (DB 객체를 메인에서 받아옴)
export default function v1Router(db) {
    const router = express.Router();

    // 1. 로그인 (POST /v1/auth/login)
    router.post('/auth/login', async (req, res) => {
        const { studentId, studentPw, grade, sclass, number } = req.body;
        try {
            const client = await getAuthenticatedSession(studentId, studentPw);
            const encryptedPw = encrypt(studentPw);
            
            // 주의: firestore.FieldValue.serverTimestamp() 대신 new Date() 사용 (의존성 최소화)
            await db.collection('users').doc(studentId).set({
                studentId, encryptedPw, grade, class: sclass, number, updatedAt: new Date()
            }, { merge: true });

            const sessionToken = crypto.randomUUID();
            await db.collection('sessions').doc(sessionToken).set({
                studentId: studentId, createdAt: new Date()
            });

            const rewardResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=1`);
            const totalReward = (cheerio.load(rewardResponse.data)('#rewordTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0';
            
            const penaltyResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=2`);
            const totalPenalty = (cheerio.load(penaltyResponse.data)('#punishmentTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0';

            res.json({ 
                success: true, sessionToken, totalReward, totalPenalty, 
                rewardList: parseTable(rewardResponse.data), penaltyList: parseTable(penaltyResponse.data) 
            });
        } catch (error) { res.status(500).json({ success: false, message: `오류: ${error.message}` }); }
    });

    // 2. 자동 로그인 (POST /v1/auth/auto-login)
    router.post('/auth/auto-login', async (req, res) => {
        const { token } = req.body;
        if (!token) return res.status(401).json({ success: false, message: '토큰 없음' });
        try {
            const sessionDoc = await db.collection('sessions').doc(token).get();
            if (!sessionDoc.exists) return res.status(401).json({ success: false, message: '만료된 세션' });

            const { studentId } = sessionDoc.data();
            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));
            
            const rewardResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=1`);
            const penaltyResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=2`);

            res.json({ 
                success: true, studentId, 
                totalReward: (cheerio.load(rewardResponse.data)('#rewordTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0', 
                totalPenalty: (cheerio.load(penaltyResponse.data)('#punishmentTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0', 
                rewardList: parseTable(rewardResponse.data), penaltyList: parseTable(penaltyResponse.data) 
            });
        } catch (error) { res.status(500).json({ success: false, message: `오류: ${error.message}` }); }
    });

    // 3. 연동 해제 (POST /v1/auth/disconnect)
    router.post('/auth/disconnect', async (req, res) => {
        const { studentId, token } = req.body;
        try {
            await db.collection('users').doc(studentId).delete();
            if (token) await db.collection('sessions').doc(token).delete();
            res.json({ success: true, message: '계정 연동이 해제되었습니다.' });
        } catch (error) { res.status(500).json({ success: false }); }
    });

    // 4. 신청 내역 조회 (GET /v1/applications)
    router.get('/applications', async (req, res) => {
        const { studentId, token } = req.query;
        if (!token) return res.status(401).json({ success: false, message: '토큰 누락' });
        try {
            const sessionDoc = await db.collection('sessions').doc(token).get();
            if (!sessionDoc.exists || sessionDoc.data().studentId !== studentId) return res.status(401).json({ success: false, message: '권한 없음' });

            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));

            // 자율학습 파싱
            const studyRes = await client.get(`${SCHOOL_BASE_URL}/study/list.php`);
            const $study = cheerio.load(studyRes.data);
            const studyList = [];
            $study('table.table.table-hover tbody tr').each((i, el) => {
                const tds = $study(el).find('td');
                if (tds.length >= 7 && !tds.eq(0).text().includes('없습니다')) {
                    studyList.push({
                        id: tds.eq(0).find('input[type=checkbox]').val() || '',
                        date: tds.eq(2).text().trim(), time: tds.eq(3).text().trim(),
                        place: tds.eq(4).text().trim(), detail: tds.eq(5).text().trim(),
                        status: tds.last().text().trim() || '대기'
                    });
                }
            });

            // 외출/외박 파싱
            const outRes = await client.get(`${SCHOOL_BASE_URL}/out/list.php`);
            const $out = cheerio.load(outRes.data);
            const outList = [];
            $out('table.table.table-hover tbody tr').each((i, el) => {
                const tds = $out(el).find('td');
                if (tds.length >= 7 && !tds.eq(0).text().includes('없습니다')) {
                    const timeParts = tds.eq(3).text().replace(/\s+/g, ' ').trim().split('-').map(t => t.trim());
                    outList.push({
                        id: tds.eq(0).find('input[name=itemCheck]').val() || '',
                        type: tds.eq(2).text().trim(), reason: tds.eq(4).text().trim(),
                        outDate: timeParts[0] || '', inDate: timeParts[1] || '',
                        status: tds.last().text().trim() || '대기'
                    });
                }
            });

            res.json({ success: true, studyList, outList });
        } catch (error) { res.status(500).json({ success: false, message: `서버 오류: ${error.message}` }); }
    });

    // 5. 자율학습 신청 (POST /v1/applications/study)
    router.post('/applications/study', async (req, res) => {
        const { studentId, token, date, time, place, detail, detail_reason } = req.body;
        try {
            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));
            const params = new URLSearchParams({ mode: 'apply', reason: '1', date, time, place, detail: detail || '', detail_reason: detail_reason || '' });
            
            const response = await client.post(`${SCHOOL_BASE_URL}/Lib/study_apply.action.php`, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
            if (String(response.data).includes('실패') || String(response.data).includes('history.back')) return res.status(400).json({ success: false, message: '신청 기간 아님 / 이미 신청됨' });
            res.json({ success: true, message: '완료' });
        } catch (error) { res.status(500).json({ success: false }); }
    });

    // 6. 외출 신청 (POST /v1/applications/out)
    router.post('/applications/out', async (req, res) => {
        const { studentId, token, type, reason, bdate, edate } = req.body;
        try {
            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));
            const params = new URLSearchParams({ mode: 'apply', type, reason, bdate, edate });
            
            const response = await client.post(`${SCHOOL_BASE_URL}/Lib/school_out.action.php`, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
            if (String(response.data).includes('실패') || String(response.data).includes('history.back')) return res.status(400).json({ success: false, message: '외출 거절됨' });
            res.json({ success: true, message: '완료' });
        } catch (error) { res.status(500).json({ success: false }); }
    });

    // 7. 삭제 및 취소 (DELETE /v1/applications/:type/:id)
    router.delete('/applications/:type/:id', async (req, res) => {
        const { type, id } = req.params;
        const { studentId, token } = req.body;
        try {
            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));
            
            const actionUrl = type === 'out' ? `${SCHOOL_BASE_URL}/Lib/school_out.action.php` : `${SCHOOL_BASE_URL}/Lib/study_apply.action.php`;
            const params = new URLSearchParams({ mode: 'apply_del', del_items: id });

            const response = await client.post(actionUrl, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
            const text = String(response.data);

            if (text.includes('PERM_ERR')) return res.status(403).json({ success: false, message: '권한 없음' });
            if (text.includes('CHANGED_STATE_EXIST')) return res.status(400).json({ success: false, message: '이미 승인/거절되어 삭제 불가' });
            
            res.json({ success: true, message: '삭제됨' });
        } catch (error) { res.status(500).json({ success: false }); }
    });

    return router;
}
