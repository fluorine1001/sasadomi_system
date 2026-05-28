import express from 'express';
import crypto from 'crypto';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import axios from 'axios';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';

const SCHOOL_BASE_URL = 'https://sasadomi.hs.kr';
const ENCRYPTION_KEY = process.env.SECRET_KEY || 'a'.repeat(32); 
const IV_LENGTH = 16;
const myCache = new NodeCache({ stdTTL: 180, checkperiod: 120 });

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

// 🟢 일시 문자열 가독성 및 일관성 포맷터 함수 (05-28(목) -> 05-28 (목))
function formatDateTime(str) {
    if (!str) return '';
    return str
        .replace(/\s*(\([일월화수목금토]\))\s*/g, ' $1 ')
        .trim()
        .replace(/\s+/g, ' ');
}

// 🟢 상벌점 테이블 전용 파싱 함수 (번호, 점수, 내용/코멘트, 날짜 순서)
function parseTable(html) {
    const $ = cheerio.load(html);
    const list = [];
    $('table.table-hover tr').each((index, element) => {
        const tds = $(element).find('td');
        if (tds.length >= 4) {
            const no = tds.eq(0).text().trim();
            const score = tds.eq(1).text().trim();
            
            // 3번째 td에서 사유와 코멘트 분리
            const contentTd = tds.eq(2);
            const commentNode = contentTd.find('.coment');
            let comment = '';
            
            if (commentNode.length > 0) {
                // 이미지 alt 텍스트 등 불필요한 문자열 제거 후 순수 코멘트 추출
                comment = commentNode.text().replace(/코멘트아이콘/g, '').trim();
                commentNode.remove(); // 원본에서 코멘트 태그 완전히 삭제
            }
            const reason = contentTd.text().trim();
            
            list.push({
                no: no,
                score: score,
                reason: reason,
                comment: comment,
                date: formatDateTime(tds.eq(3).text().trim())
            });
        }
    });
    return list;
}

export default function v1Router(db, admin) {
    const router = express.Router();

    /**
     * @swagger
     * /v1/meta/options:
     *   get:
     *     summary: 신청 폼 선택지(메타데이터) 조회
     *     description: 자율학습 신청(교시, 장소, 담당교사) 및 외출 신청(시간)에 필요한 유효 옵션 목록을 상수로 반환합니다.
     *     tags: [Meta]
     *     responses:
     *       200:
     *         description: 옵션 조회 성공
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: true }
     *                 studyTimes:
     *                   type: array
     *                   description: 자율학습 신청 시 선택 가능한 시간대 목록
     *                   items:
     *                     type: object
     *                     properties:
     *                       value: { type: string, example: "1" }
     *                       label: { type: string, example: "오전" }
     *                 studyPlaces:
     *                   type: array
     *                   description: 자율학습 신청 시 선택 가능한 장소 목록
     *                   items:
     *                     type: object
     *                     properties:
     *                       value: { type: string, example: "1" }
     *                       label: { type: string, example: "호실(요양)-주간 평일 3회" }
     *                 teachers:
     *                   type: array
     *                   description: 본관 활동 등 승인에 필요한 지도교사 이름 목록 (학교 시스템에 등록된 전체 교사 풀)
     *                   items: { type: string, example: "김사사" }
     *                 outTimes:
     *                   type: array
     *                   description: 외출/외박 신청 시 선택 가능한 1시간 단위 고정 시간 배열 (00:00부터 23:00까지 24개 항목)
     *                   items: { type: string, example: "00:00" }
     */
    router.get('/meta/options', (req, res) => {
        res.json({
            success: true,
            studyTimes: [
                { value: "1", label: "오전" }, { value: "2", label: "오후" },
                { value: "3", label: "학습 I" }, { value: "4", label: "학습 II" },
                { value: "5", label: "연장 학습(00~01시)" }, { value: "6", label: "연장 학습(01~02시)" }
            ],
            studyPlaces: [
                { value: "1", label: "호실(요양)-주간 평일 3회" }, { value: "2", label: "휴게실" },
                { value: "3", label: "본관" }, { value: "4", label: "정독실" },
                { value: "5", label: "세미나공간" }, { value: "6", label: "3층 스터디룸" },
                { value: "7", label: "소학습실(1층)" }, { value: "8", label: "소학습실(2층)" },
                { value: "9", label: "소학습실(3층)" }, { value: "10", label: "소학습실(4층)" },
                { value: "11", label: "소학습실(5층)" }
            ],
            teachers: [
                "강계화", "고민지", "고유선", "고준태", "곽승철", "구금주", "구대환", "길승호", "김기향", "김대중", "김명희", "김문태", "김미리", "김백진", "김선아", "김수미", "김승진", "김승현", "김승환", "김예은", "김정화", "김종헌", "김지현", "김지혜", "김현철", "김희수", "남민경", "문재은", "박고운", "박순", "박연순", "박은영", "손창환", "신현정", "안정수", "양영규", "유연정", "이경민", "이경진", "이동천", "이민호", "이산", "이상숙", "이성현", "이승현", "이예찬", "이제림", "이주미", "이지은", "이현아", "이효빈", "임건웅", "장혜민", "전윤미", "전재성", "정세영", "조승훈", "조현주", "주지웅", "진대성", "진소영", "한지선", "홍주환", "휴일도서관"
            ],
            outTimes: [
                "00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00",
                "08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00",
                "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00"
            ]
        });
    });

    /**
     * @swagger
     * /v1/auth/login:
     *   post:
     *     summary: 학교 계정으로 로그인 및 연동
     *     description: 학생의 원본 기숙사 시스템 ID/PW를 검증하고, 비밀번호를 AES-256-CBC 알고리즘으로 암호화하여 데이터베이스에 연동(저장)한 후 영속 세션 토큰을 발급합니다.
     *     tags: [Auth]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [studentId, studentPw]
     *             properties:
     *               studentId: { type: string, example: "s2024010101", description: "11자리 문자열 학번 기숙사 아이디 (s + 입학년도 4자리 + 학년 1자리 + 반 2자리 + 번호 2자리)" }
     *               studentPw: { type: string, example: "mypassword!", description: "기숙사 시스템 비밀번호" }
     *     responses:
     *       200:
     *         description: 로그인 및 DB 연동 성공
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: true }
     *                 sessionToken: { type: string, example: "a1b2c3d4-e5f6-7g8h-i9j0-k1l2m3n4o5p6", description: "클라이언트에 영구 저장할 UUID v4 형태의 세션 토큰" }
     *       400:
     *         description: 유효하지 않은 학번 규격
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: false }
     *                 message: { type: string, example: "올바른 학번(11자리)을 제공해주세요." }
     *       500:
     *         description: 학교 기숙사 서버 로그인 실패 또는 내부 통신 암호화 오류
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: false }
     *                 message: { type: string, example: "오류: 학교 로그인 페이지 접속 실패" }
     */
    router.post('/auth/login', async (req, res) => {
        const { studentId, studentPw } = req.body;
        try {
            if (!studentId || studentId.length !== 11) {
                return res.status(400).json({ success: false, message: '올바른 학번(11자리)을 제공해주세요.' });
            }
            const grade = parseInt(studentId.substring(5, 7), 10).toString();
            const sclass = parseInt(studentId.substring(7, 9), 10).toString();
            const number = parseInt(studentId.substring(9, 11), 10).toString();

            const client = await getAuthenticatedSession(studentId, studentPw);
            const encryptedPw = encrypt(studentPw);
            
            await db.collection('users').doc(studentId).set({
                studentId, encryptedPw, grade, class: sclass, number, updatedAt: new Date()
            }, { merge: true });

            const sessionToken = crypto.randomUUID();
            await db.collection('sessions').doc(sessionToken).set({
                studentId: studentId, createdAt: new Date()
            });

            res.json({ success: true, sessionToken });
        } catch (error) { res.status(500).json({ success: false, message: `오류: ${error.message}` }); }
    });

    /**
     * @swagger
     * /v1/auth/auto-login:
     *   post:
     *     summary: 토큰 기반 자동 로그인 검증
     *     description: 클라이언트에 보관 중인 UUID 세션 토큰의 유효성을 검사하고, 세션이 살아있다면 연동된 학번 정보를 반환합니다.
     *     tags: [Auth]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [token]
     *             properties:
     *               token: { type: string, example: "a1b2c3d4-e5f6-7g8h..." }
     *     responses:
     *       200:
     *         description: 토큰 검증 성공 (자동 로그인 완료)
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: true }
     *                 studentId: { type: string, example: "s2024010101" }
     *       401:
     *         description: 토큰이 없거나 만료되었거나 연동 유저 정보가 존재하지 않음
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: false }
     *                 message: { type: string, example: "만료된 세션" }
     *       500:
     *         description: 데이터베이스 조회 오류
     */
    router.post('/auth/auto-login', async (req, res) => {
        const { token } = req.body;
        if (!token) return res.status(401).json({ success: false, message: '토큰 없음' });
        try {
            const sessionDoc = await db.collection('sessions').doc(token).get();
            if (!sessionDoc.exists) return res.status(401).json({ success: false, message: '만료된 세션' });

            const { studentId } = sessionDoc.data();
            const userDoc = await db.collection('users').doc(studentId).get();
            if (!userDoc.exists) return res.status(401).json({ success: false, message: '유저 정보 없음' });

            res.json({ success: true, studentId });
        } catch (error) { res.status(500).json({ success: false, message: `오류: ${error.message}` }); }
    });

    /**
     * @swagger
     * /v1/auth/disconnect:
     *   post:
     *     summary: 계정 연동 해제 및 데이터 파기
     *     description: 사용자의 요청에 따라 데이터베이스에 보관 중인 암호화 유저 정보 문서 및 세션 토큰을 영구 파기하고 로컬 서버 캐시를 초기화합니다.
     *     tags: [Auth]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [studentId]
     *             properties:
     *               studentId: { type: string, example: "s2024010101" }
     *               token: { type: string, example: "a1b2c3d4-e5f6-7g8h...", description: "파기할 세션 토큰 (선택 사항)" }
     *     responses:
     *       200:
     *         description: 연동 데이터 파기 완료
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: true }
     *                 message: { type: string, example: "계정 연동이 해제되었습니다." }
     *       500:
     *         description: 데이터베이스 삭제 처리 오류
     */
    router.post('/auth/disconnect', async (req, res) => {
        const { studentId, token } = req.body;
        try {
            await db.collection('users').doc(studentId).delete();
            if (token) await db.collection('sessions').doc(token).delete();
            myCache.del(`apps_${studentId}`);
            myCache.del(`points_${studentId}`);
            res.json({ success: true, message: '계정 연동이 해제되었습니다.' });
        } catch (error) { res.status(500).json({ success: false }); }
    });

    /**
     * @swagger
     * /v1/points:
     *   get:
     *     summary: 상벌점 내역 조회 (캐싱 적용)
     *     description: 3분(180초) 간의 로컬 메모리 캐싱이 적용됩니다. 캐시 미스 시 원본 기숙사 사이트 상벌점 페이지 탭을 크롤링 및 파싱하여 상세 목록과 총점을 빌드합니다.
     *     tags: [Points]
     *     parameters:
     *       - in: query
     *         name: studentId
     *         required: true
     *         schema: { type: string }
     *         description: 조회 대상 학번
     *       - in: query
     *         name: token
     *         required: true
     *         schema: { type: string }
     *         description: 권한을 검증할 유효 세션 토큰
     *     responses:
     *       200:
     *         description: 상벌점 데이터 집계 완료 (캐시 또는 실시간 크롤링 결과)
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: true }
     *                 totalReward: { type: string, example: "12", description: "누적 상점 총점" }
     *                 totalPenalty: { type: string, example: "2", description: "누적 벌점 총점" }
     *                 rewardList:
     *                   type: array
     *                   description: 학생에게 부여된 상점 상세 내역 목록 (번호, 점수, 내용/코멘트, 날짜 순서)
     *                   items:
     *                     type: object
     *                     properties:
     *                       no: { type: string, example: "1" }
     *                       score: { type: string, example: "2" }
     *                       reason: { type: string, example: "정독실 면학 태도 우수" }
     *                       comment: { type: string, example: "5월 호실 점검 청결 상태 우수" }
     *                       date: { type: string, example: "05-28 (목)" }
     *                 penaltyList:
     *                   type: array
     *                   description: 학생에게 부여된 벌점 상세 내역 목록 (번호, 점수, 내용/코멘트, 날짜 순서)
     *                   items:
     *                     type: object
     *                     properties:
     *                       no: { type: string, example: "1" }
     *                       score: { type: string, example: "1" }
     *                       reason: { type: string, example: "지각" }
     *                       comment: { type: string, example: "아침 점호 10분 지각" }
     *                       date: { type: string, example: "04-12 (일)" }
     *       401:
     *         description: 토큰 누락 또는 세션과 학번의 비매칭 (권한 없음)
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: false }
     *                 message: { type: string, example: "권한 없음" }
     *       500:
     *         description: 기숙사 웹 크롤링 파싱 실패 또는 암호화PW 복호화 실패
     */
    router.get('/points', async (req, res) => {
        const { studentId, token } = req.query;
        if (!token) return res.status(401).json({ success: false, message: '토큰 누락' });

        const cacheKey = `points_${studentId}`;
        const cachedData = myCache.get(cacheKey);
        if (cachedData) return res.json(cachedData);

        try {
            const sessionDoc = await db.collection('sessions').doc(token).get();
            if (!sessionDoc.exists || sessionDoc.data().studentId !== studentId) {
                return res.status(401).json({ success: false, message: '권한 없음' });
            }

            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));

            const rewardResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=1`);
            const totalReward = (cheerio.load(rewardResponse.data)('#rewordTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0';
            
            const penaltyResponse = await client.get(`${SCHOOL_BASE_URL}/point/list.php?tab=2`);
            const totalPenalty = (cheerio.load(penaltyResponse.data)('#punishmentTab p').eq(1).text() || '0').replace(/[^0-9]/g, '') || '0';

            const responseData = { 
                success: true, 
                totalReward, 
                totalPenalty, 
                rewardList: parseTable(rewardResponse.data), 
                penaltyList: parseTable(penaltyResponse.data) 
            };

            myCache.set(cacheKey, responseData);
            res.json(responseData);
        } catch (error) { res.status(500).json({ success: false, message: `서버 오류: ${error.message}` }); }
    });

    /**
     * @swagger
     * /v1/applications:
     *   get:
     *     summary: 자율학습 및 외출/외박 신청 내역 통합 조회 (캐싱 적용)
     *     description: 3분 간의 캐싱이 지원됩니다. 원본 기숙사 웹의 자율학습 신청현황과 외출/외박 신청현황 목록을 파싱하여 정제된 리스트로 통합 반환합니다.
     *     tags: [Applications]
     *     parameters:
     *       - in: query
     *         name: studentId
     *         required: true
     *         schema: { type: string }
     *       - in: query
     *         name: token
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: 신청 목록 통합 빌드 완료
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: true }
     *                 studyList:
     *                   type: array
     *                   description: 자율학습 신청 내역 목록
     *                   items:
     *                     type: object
     *                     properties:
     *                       id: { type: string, example: "12543", description: "취소/삭제 처리에 사용되는 원본 체크박스 고유 ID값" }
     *                       no: { type: string, example: "1", description: "UI용 번호" }
     *                       date: { type: string, example: "05-28 (목)" }
     *                       time: { type: string, example: "학습 I", description: "신청한 교시 라벨 텍스트 (/v1/meta/options 출처)" }
     *                       place: { type: string, example: "정독실", description: "자율학습 장소 라벨 텍스트 (/v1/meta/options 출처)" }
     *                       teacher: { type: string, example: "김사사", description: "/v1/meta/options의 teachers 목록에 존재하는 지도교사 이름 (라벨)" }
     *                       detail: { type: string, example: "수학 집중 학습" }
     *                       applyDate: { type: string, example: "05-27 (수) 18:22" }
     *                       status: { type: string, example: "승인", description: "승인 / 거절 / 대기" }
     *                 outList:
     *                   type: array
     *                   description: 외출/외박 신청 내역 목록
     *                   items:
     *                     type: object
     *                     properties:
     *                       id: { type: string, example: "9874", description: "외출 취소 처리에 필수적인 고유 식별자 ID" }
     *                       no: { type: string, example: "1", description: "UI용 번호" }
     *                       type: { type: string, example: "외출", description: "외출 / 외박" }
     *                       reason: { type: string, example: "귀가" }
     *                       outDate: { type: string, example: "05-29 (금) 17:00" }
     *                       inDate: { type: string, example: "05-31 (일) 21:00" }
     *                       applyDate: { type: string, example: "05-27 (수) 18:22" }
     *                       status: { type: string, example: "대기" }
     *       401:
     *         description: 세션 불일치 또는 토큰 누락
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: false }
     *                 message: { type: string, example: "권한 없음" }
     *       500:
     *         description: 학교 기숙사 세션 연결 원격 실패
     */
    router.get('/applications', async (req, res) => {
        const { studentId, token } = req.query;
        if (!token) return res.status(401).json({ success: false, message: '토큰 누락' });

        const cacheKey = `apps_${studentId}`;
        const cachedData = myCache.get(cacheKey);
        if (cachedData) return res.json(cachedData);

        try {
            const sessionDoc = await db.collection('sessions').doc(token).get();
            if (!sessionDoc.exists || sessionDoc.data().studentId !== studentId) return res.status(401).json({ success: false, message: '권한 없음' });

            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));

            // 자율학습 내역 파싱
            const studyRes = await client.get(`${SCHOOL_BASE_URL}/study/list.php`);
            const $study = cheerio.load(studyRes.data);
            const studyList = [];
            $study('table.table.table-hover tbody tr').each((i, el) => {
                const tds = $study(el).find('td');
                if (tds.length >= 9 && !tds.eq(0).text().includes('없습니다')) {
                    const statusText = tds.eq(8).text().trim();
                    studyList.push({
                        id: tds.eq(0).find('input[type=checkbox]').val() || '',
                        no: tds.eq(1).text().trim(),
                        date: formatDateTime(tds.eq(2).text().trim()), 
                        time: tds.eq(3).text().trim(),
                        place: tds.eq(4).text().trim(),
                        teacher: tds.eq(5).text().trim(),
                        detail: tds.eq(6).text().trim(),
                        applyDate: formatDateTime(tds.eq(7).text().trim()), 
                        status: statusText === '' ? '대기' : statusText
                    });
                }
            });

            // 외출/외박 내역 파싱
            const outRes = await client.get(`${SCHOOL_BASE_URL}/out/list.php`);
            const $out = cheerio.load(outRes.data);
            const outList = [];
            $out('table.table.table-hover tbody tr').each((i, el) => {
                const tds = $out(el).find('td');
                if (tds.length >= 7 && !tds.eq(0).text().includes('없습니다')) {
                    const timeText = tds.eq(3).text().replace(/\xA0/g, ' ').trim();
                    let outDate = '';
                    let inDate = '';

                    const timeMatch = timeText.match(/^(.+?\d{2}:\d{2})\s*-\s*(.+)$/);
                    if (timeMatch) {
                        outDate = timeMatch[1].replace(/\s+/g, ' ').trim();
                        inDate = timeMatch[2].replace(/\s+/g, ' ').trim();
                    } else {
                        const fallbackParts = timeText.split(' - ');
                        outDate = fallbackParts[0] ? fallbackParts[0].trim() : timeText;
                        inDate = fallbackParts[1] ? fallbackParts[1].trim() : '';
                    }

                    const statusText = tds.eq(6).text().trim();
                    outList.push({
                        id: tds.eq(0).find('input[name=itemCheck]').val() || '',
                        no: tds.eq(1).text().trim(),
                        type: tds.eq(2).text().trim(), 
                        outDate: formatDateTime(outDate), 
                        inDate: formatDateTime(inDate),   
                        reason: tds.eq(4).text().trim(),
                        applyDate: formatDateTime(tds.eq(5).text().trim()), 
                        status: statusText === '' ? '대기' : statusText
                    });
                }
            });

            const responseData = { success: true, studyList, outList };
            myCache.set(cacheKey, responseData);
            res.json(responseData);
        } catch (error) { res.status(500).json({ success: false, message: `서버 오류: ${error.message}` }); }
    });

    /**
     * @swagger
     * /v1/applications/study:
     *   post:
     *     summary: 자율학습 신청 대행
     *     description: 원본 기숙사 비즈니스 폼 액션 주소로 HTTP POST 데이터 전송을 대행합니다. 처리 성공 시 연동 유저의 신청 내역 관련 로컬 캐시를 강제 비웁니다.
     *     tags: [Applications]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [studentId, token, date, time, place]
     *             properties:
     *               studentId: { type: string, example: "s2024010101" }
     *               token: { type: string, example: "a1b2c3d4..." }
     *               date: { type: string, description: "신청 날짜 (YYYY-MM-DD 규격 등 파싱 가능 형식)", example: "2026-05-29" }
     *               time: { type: string, description: "반드시 /v1/meta/options에서 조회한 studyTimes의 value 값을 사용해야 합니다 (예: 1~6)", example: "3" }
     *               place: { type: string, description: "반드시 /v1/meta/options에서 조회한 studyPlaces의 value 값을 사용해야 합니다. '3'은 본관을 의미합니다.", example: "3" }
     *               detail: { type: string, description: "지도교사 이름. 장소(place)가 '3'(본관)인 경우에만 필수 선택 항목이며, 그 외 장소일 경우에는 강제로 빈 문자열('')이 전송됩니다.", example: "김사사" }
     *               detail_reason: { type: string, description: "기타 사유 국어 텍스트", example: "" }
     *     responses:
     *       200:
     *         description: 자율학습 원격 신청 완료 및 내부 캐시 무효화 성공
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: true }
     *                 message: { type: string, example: "완료" }
     *       400:
     *         description: 본관 신청 시 지도교사가 누락되었거나 학교 원본 폼 시스템에서 '실패' 스크립트가 반환됨
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: false }
     *                 message: { type: string, example: "본관 신청 시 지도교사 선택은 필수입니다." }
     *       500:
     *         description: 원격 서버 네트워크 장애
     */
    router.post('/applications/study', async (req, res) => {
        const { studentId, token, date, time, place, detail, detail_reason } = req.body;
        try {
            // 🟢 지도교사 선택 조건부 필수 검증 및 예외처리 적용
            if (place === '3' && !detail) {
                return res.status(400).json({ success: false, message: '본관 신청 시 지도교사 선택은 필수입니다.' });
            }
            const finalDetail = place === '3' ? detail : '';

            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));
            // [수정 할 코드]
            // 1. KST(+09:00) 기준 00시 00분 타임스탬프 생성
            const dateTimestamp = Math.floor(new Date(`${date}T00:00:00+09:00`).getTime() / 1000);
            
            // 2. 파라미터에 date 대신 dateTimestamp 매핑
            const params = new URLSearchParams({ 
                mode: 'apply', 
                reason: '1', 
                date: dateTimestamp,  // 👈 문자열 대신 타임스탬프 숫자 삽입
                time, 
                place, 
                detail: finalDetail, 
                detail_reason: detail_reason || '' 
            });
            
            const response = await client.post(`${SCHOOL_BASE_URL}/Lib/study_apply.action.php`, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            if (String(response.data).includes('실패') || String(response.data).includes('history.back')) return res.status(400).json({ success: false, message: '신청 기간 아님 / 이미 신청됨' });
            
            myCache.del(`apps_${studentId}`);
            res.json({ success: true, message: '완료' });
        } catch (error) { res.status(500).json({ success: false }); }
    });

    /**
     * @swagger
     * /v1/applications/out:
     *   post:
     *     summary: 외출/외박 신청 대행
     *     description: 원본 기숙사 외출/외박 처리 폼으로 네트워크 요청을 우회 송신합니다.
     *     tags: [Applications]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [studentId, token, type, reason, bdate, edate]
     *             properties:
     *               studentId: { type: string, example: "s2024010101" }
     *               token: { type: string }
     *               type: { type: string, enum: [외출, 외박], example: "외출" }
     *               reason: { type: string, example: "서점 방문 및 도서 구매" }
     *               bdate: { type: string, description: "출발 일시 정보", example: "2026-05-29 17:00" }
     *               edate: { type: string, description: "귀교 일시 정보", example: "2026-05-29 21:00" }
     *     responses:
     *       200:
     *         description: 외출/외박 폼 접수 성공
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: true }
     *                 message: { type: string, example: "완료" }
     *       400:
     *         description: 마감 시간 초과 또는 외출 조건 규격 미달로 학교 시스템 측에서 거절됨
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: false }
     *                 message: { type: string, example: "외출 거절됨" }
     *       500:
     *         description: 내부 통신 오류
     */
    router.post('/applications/out', async (req, res) => {
        // [수정 할 코드]
        // 1. 프론트엔드로부터 날짜와 시간을 각각 분리해서 받도록 req.body 수정
        const { studentId, token, type, reason, bdate, btime, edate, etime } = req.body;
        try {
            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));
            // 2. 시간 규격화 (예: "01:00" 형태 보장) 및 KST 기준 타임스탬프 계산
            const bhour = String(btime).includes(':') ? btime : `${String(btime).padStart(2, '0')}:00`;
            const ehour = String(etime).includes(':') ? etime : `${String(etime).padStart(2, '0')}:00`;
            
            const bdateTimestamp = Math.floor(new Date(`${bdate}T${bhour}:00+09:00`).getTime() / 1000);
            const edateTimestamp = Math.floor(new Date(`${edate}T${ehour}:00+09:00`).getTime() / 1000);
            
            // 3. 파라미터 매핑
            const params = new URLSearchParams({ 
                mode: 'apply', 
                type, 
                reason, 
                bdate: bdateTimestamp, // 👈 타임스탬프 할당
                edate: edateTimestamp  // 👈 타임스탬프 할당
            });
            
            const response = await client.post(`${SCHOOL_BASE_URL}/Lib/school_out.action.php`, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            if (String(response.data).includes('실패') || String(response.data).includes('history.back')) return res.status(400).json({ success: false, message: '외출 거절됨' });
            
            myCache.del(`apps_${studentId}`);
            res.json({ success: true, message: '완료' });
        } catch (error) { res.status(500).json({ success: false }); }
    });

    /**
     * @swagger
     * /v1/applications/{type}/{id}:
     *   delete:
     *     summary: 신청 내역 취소/삭제
     *     description: 접수되거나 승인 대기 중인 특정 자율학습 또는 외출 내역을 원본 기숙사 시스템 상에서 영구 취소 및 삭제 처리합니다.
     *     tags: [Applications]
     *     parameters:
     *       - in: path
     *         name: type
     *         required: true
     *         schema: { type: string, enum: [study, out] }
     *         description: "취소 타겟 분류 도메인 (자율학습은 study, 외출/외박은 out)"
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *         description: "체크박스 로드 시 함께 파싱되었던 고유 레코드 아이디(id/itemCheck value)"
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [studentId, token]
     *             properties:
     *               studentId: { type: string, example: "s2024010101" }
     *               token: { type: string }
     *     responses:
     *       200:
     *         description: 신청 취소 원격 반영 완료
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: true }
     *                 message: { type: string, example: "삭제됨" }
     *       400:
     *         description: 이미 원본 사이트 상에서 사감 교사에 의해 승인 완료 혹은 반려 확정 상태로 변경되어 제어할 수 없는 경우
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: false }
     *                 message: { type: string, example: "이미 승인/거절되어 삭제 불가" }
     *       403:
     *         description: 타인의 고유 ID에 접근을 시도하는 등 세션 권한 매칭 실패
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success: { type: boolean, example: false }
     *                 message: { type: string, example: "권한 없음" }
     *       500:
     *         description: 백엔드 런타임 오류
     */
    router.delete('/applications/:type/:id', async (req, res) => {
        const { type, id } = req.params;
        const { studentId, token } = req.body;
        try {
            const userDoc = await db.collection('users').doc(studentId).get();
            const client = await getAuthenticatedSession(studentId, decrypt(userDoc.data().encryptedPw));
            
            const actionUrl = type === 'out' ? `${SCHOOL_BASE_URL}/Lib/school_out.action.php` : `${SCHOOL_BASE_URL}/Lib/study_apply.action.php`;
            const params = new URLSearchParams({ mode: 'apply_del', del_items: id });

            const response = await client.post(actionUrl, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            const text = String(response.data);

            if (text.includes('PERM_ERR')) return res.status(403).json({ success: false, message: '권한 없음' });
            if (text.includes('CHANGED_STATE_EXIST')) return res.status(400).json({ success: false, message: '이미 승인/거절되어 삭제 불가' });
            
            myCache.del(`apps_${studentId}`);
            res.json({ success: true, message: '삭제됨' });
        } catch (error) { res.status(500).json({ success: false }); }
    });

    return router;
}
