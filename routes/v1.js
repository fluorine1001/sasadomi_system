import express from 'express';
import crypto from 'crypto';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import axios from 'axios';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';

const router = express.Router();

// 📌 기숙사 시스템 원본 사이트 베이스 URL 및 암호화 설정 상수 정의
const SCHOOL_BASE_URL = 'https://sasadomi.hs.kr';
const ENCRYPTION_KEY = process.env.SECRET_KEY || 'a'.repeat(32); // 32바이트(256비트) 길이의 AES 암호화 키 생성
const IV_LENGTH = 16; // AES-256-CBC 규격에 따른 초기화 벡터(IV) 16바이트 고정

// 📌 메모리 내 데이터 캐싱 처리를 위한 NodeCache 초기화 (기본 생존 시간 180초, 만료 검사 주기 120초)
const myCache = new NodeCache({ stdTTL: 180, checkperiod: 120 });

/**
 * @function encrypt
 * @description 사용자 비밀번호 보호를 위해 AES-256-CBC 알고리즘 기반으로 양방향 암호화를 수행합니다.
 * @param {string} text - 암호화할 원본 일반 텍스트 비밀번호
 * @returns {string} iv_hex:encrypted_hex 구조로 결합된 문자열
 */
function encrypt(text) {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * @function decrypt
 * @description 데이터베이스(Firestore)에 저장된 암호문 문자열을 안전하게 복호화합니다.
 * @param {string} text - 복호화 대상 암호문 문자열 (iv_hex:encrypted_hex 구조)
 * @returns {string} 복호화가 완료된 일반 텍스트 비밀번호
 */
function decrypt(text) {
    if (!text) throw new Error("복호화할 텍스트가 존재하지 않습니다.");
    let textParts = text.split(':');
    let iv = Buffer.from(textParts.shift(), 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]); 
    return decrypted.toString();
}

/**
 * @function getAuthenticatedSession
 * @description 쿠키 단독 유지를 위해 CookieJar 가 래핑된 Axios 클라이언트를 생성하고 기숙사 원본 사이트에 로그인 인증을 수행합니다.
 * @param {string} studentId - 학번 기반 사용자 아이디
 * @param {string} password - 복호화된 일반 텍스트 비밀번호
 * @returns {Promise<object>} 인증용 쿠키 세션이 활성화된 Axios 인스턴스 반환
 */
async function getAuthenticatedSession(studentId, password) {
    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));
    
    // 원본 학교 시스템의 로그인 처리 액션 엔드포인트로 로그인 데이터 전송
    const loginUrl = `${SCHOOL_BASE_URL}/Lib/login.action.php`;
    const params = new URLSearchParams({
        mode: 'login',
        user_id: studentId,
        user_pw: password
    });

    const response = await client.post(loginUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (String(response.data).includes('LOGIN_ERR') || String(response.data).includes('fail')) {
        throw new Error('원격 기숙사 시스템 로그인 인증에 실패했습니다.');
    }

    return client;
}

/**
 * @swagger
 * /v1/points:
 *   get:
 *     summary: 상벌점 내역 실시간 조회 (캐싱 적용)
 *     description: >
 *       3분(180초) 간의 로컬 메모리 캐싱이 적용됩니다. 캐시 미스 시 원본 기숙사 사이트
 *       `/Mypage/point_list.php` 페이지를 크롤링하여 상점·벌점 총점 및 항목별 상세 내역을
 *       파싱합니다. studentId 또는 token이 누락된 경우 400을 반환합니다.
 *     tags: [Points]
 *     parameters:
 *       - in: query
 *         name: studentId
 *         required: true
 *         schema: { type: string, example: "s2024010101" }
 *         description: 조회 대상 학생의 학번 아이디
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string, example: "a1b2c3d4-e5f6-7g8h..." }
 *         description: 클라이언트에 저장된 세션 검증용 UUID 토큰
 *     responses:
 *       200:
 *         description: 상벌점 데이터 크롤링 및 파싱 성공 (캐시 또는 실시간 결과)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 rewardScore:
 *                   type: number
 *                   description: 해당 학생의 누적 상점 합산 총점
 *                   example: 5
 *                 penaltyScore:
 *                   type: number
 *                   description: 해당 학생의 누적 벌점 합산 총점
 *                   example: 2
 *                 pointsHistory:
 *                   type: array
 *                   description: 상점·벌점 부여 이력 목록 (테이블 파싱 결과)
 *                   items:
 *                     type: object
 *                     properties:
 *                       date: { type: string, example: "2026-05-12", description: "점수 부여 일자" }
 *                       type: { type: string, example: "상점", description: "부여 유형 (상점 또는 벌점)" }
 *                       score: { type: number, example: 2, description: "해당 건의 점수 수치" }
 *                       reason: { type: string, example: "기숙사 호실 청소 상태 우수", description: "점수 부여 사유" }
 *       400:
 *         description: studentId 또는 token 쿼리 파라미터 누락
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "필수 요청 파라미터(studentId 또는 token)가 누락되었습니다." }
 *       500:
 *         description: 원격 기숙사 서버 로그인 실패, 크롤링 파싱 오류, 또는 복호화 런타임 예외
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "상벌점 내역을 불러오는 중 오류가 발생했습니다." }
 *                 error: { type: string, description: "실제 예외 메시지 (디버깅용)" }
 */
router.get('/points', async (req, res) => {
    const { studentId, token } = req.query;
    if (!studentId || !token) {
        return res.status(400).json({ success: false, message: '필수 요청 파라미터(studentId 또는 token)가 누락되었습니다.' });
    }

    try {
        // 캐시 데이터가 존재하는지 검사
        const cachedData = myCache.get(`points_${studentId}`);
        if (cachedData) return res.json(cachedData);

        // Firestore 연동을 통해 암호화된 비밀번호 획득 프로세스 가상화 예시 코드
        // const userDoc = await db.collection('users').doc(studentId).get();
        // const encryptedPw = userDoc.data().encryptedPw;
        const decryptedPw = "mockPassword123!"; // 실제 연동 시 decrypt(encryptedPw)로 대체 수행

        const client = await getAuthenticatedSession(studentId, decryptedPw);
        const targetUrl = `${SCHOOL_BASE_URL}/Mypage/point_list.php`;
        const response = await client.get(targetUrl);
        
        const $ = cheerio.load(response.data);
        let rewardScore = 0;
        let penaltyScore = 0;
        const pointsHistory = [];

        // DOM 객체 파싱 로직 구현
        $('.table-responsive table tbody tr').each((_, element) => {
            const cols = $(element).find('td');
            if (cols.length >= 4) {
                const date = $(cols[0]).text().trim();
                const typeStr = $(cols[1]).text().trim(); // 상점 또는 벌점 구분
                const scoreNum = parseInt($(cols[2]).text().trim()) || 0;
                const reason = $(cols[3]).text().trim();

                if (typeStr.includes('상점')) rewardScore += scoreNum;
                if (typeStr.includes('벌점')) penaltyScore += scoreNum;

                pointsHistory.push({ date, type: typeStr, score: scoreNum, reason });
            }
        });

        const result = { success: true, rewardScore, penaltyScore, pointsHistory };
        myCache.set(`points_${studentId}`, result); // 캐시 등록 완료
        res.json(result);
    } catch (error) {
        console.error("상벌점 조회 에러:", error.message);
        res.status(500).json({ success: false, message: '상벌점 내역을 불러오는 중 오류가 발생했습니다.', error: error.message });
    }
});

/**
 * @swagger
 * /v1/meta/options:
 *   get:
 *     summary: 신청 폼 선택지(메타데이터) 조회
 *     description: >
 *       자율학습(면학) 신청 시 사용하는 교시(studyTimes), 장소(studyPlaces), 담당교사(teachers) 목록과
 *       외출·외박 신청 시 사용하는 시간대(outTimes) 고정 옵션을 상수 형태로 일괄 반환합니다.
 *       별도 인증 없이 호출 가능하며, 응답 데이터는 서버 재시작 전까지 변경되지 않습니다.
 *     tags: [Meta]
 *     responses:
 *       200:
 *         description: 옵션 메타데이터 조회 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 studyTimes:
 *                   type: array
 *                   description: 자율학습 신청 가능 교시 목록 (면학 시간대 라벨 문자열 배열)
 *                   items: { type: string, example: "1면학 (19:00 ~ 21:00)" }
 *                 studyPlaces:
 *                   type: array
 *                   description: 자율학습 신청 가능 장소 목록 (면학실 라벨 문자열 배열)
 *                   items: { type: string, example: "본관 일반 교실" }
 *                 teachers:
 *                   type: array
 *                   description: 본관 신청 시 선택 가능한 지도교사 이름 및 담당 과목 목록
 *                   items: { type: string, example: "홍길동 (국어)" }
 *                 outTimes:
 *                   type: array
 *                   description: 외출·외박 신청 시 선택 가능한 출발/귀교 시간대 목록 (HH:mm 포맷)
 *                   items: { type: string, example: "09:00" }
 *       500:
 *         description: 메타데이터 구성 중 예상치 못한 서버 내부 오류 발생
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "메타데이터 로딩 실패" }
 */
router.get('/meta/options', (req, res) => {
    try {
        const metaOptions = {
            success: true,
            studyTimes: ["1면학 (19:00 ~ 21:00)", "2면학 (21:30 ~ 23:30)", "심야면학 (24:00 ~ 02:00)"],
            studyPlaces: ["본관 일반 교실", "자가면학실(기숙사 고정석)", "정보실습실", "과학실험실"],
            teachers: ["홍길동 (국어)", "김철수 (수학)", "이영희 (과학)", "박민수 (영어)"],
            outTimes: ["09:00", "12:00", "13:00", "17:00", "18:00", "21:00"]
        };
        res.json(metaOptions);
    } catch (error) {
        res.status(500).json({ success: false, message: '메타데이터 로딩 실패' });
    }
});

/**
 * @swagger
 * /v1/applications:
 *   get:
 *     summary: 자율학습 및 외출·외박 신청 내역 통합 조회 (캐싱 적용)
 *     description: >
 *       3분(180초) 간의 로컬 메모리 캐싱이 적용됩니다. 캐시 미스 시 원본 기숙사 사이트의
 *       `/Apply/study_list.php`(면학)와 `/Apply/out_list.php`(외출·외박) 페이지를 각각
 *       크롤링하여, 파싱된 두 내역을 studyHistory·outHistory 필드로 통합 반환합니다.
 *       studentId 또는 token이 누락된 경우 400을 반환합니다.
 *     tags: [Applications]
 *     parameters:
 *       - in: query
 *         name: studentId
 *         required: true
 *         schema: { type: string, example: "s2024010101" }
 *         description: 조회 대상 학생의 학번 아이디
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string, example: "a1b2c3d4-e5f6-7g8h..." }
 *         description: 클라이언트에 저장된 세션 검증용 UUID 토큰
 *     responses:
 *       200:
 *         description: 면학·외출외박 신청 내역 통합 파싱 성공 (캐시 또는 실시간 결과)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 studyHistory:
 *                   type: array
 *                   description: 자율학습(면학) 신청 내역 목록
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: "study_a1b2c3", description: "내역 고유 식별자 (data-id 속성 또는 랜덤 생성값)" }
 *                       date: { type: string, example: "2026-05-28", description: "면학 신청 일자" }
 *                       time: { type: string, example: "1면학 (19:00 ~ 21:00)", description: "신청한 면학 교시 라벨" }
 *                       place: { type: string, example: "본관 일반 교실", description: "신청한 면학 장소 라벨" }
 *                       teacher: { type: string, example: "홍길동 (국어)", description: "담당 지도교사 이름" }
 *                       reason: { type: string, example: "수학 선행 학습", description: "면학 사유 또는 상세 활동 계획" }
 *                       status: { type: string, example: "승인", description: "현재 처리 상태 (승인 / 거절 / 대기)" }
 *                 outHistory:
 *                   type: array
 *                   description: 외출·외박 신청 내역 목록
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: "out_x9y8z7", description: "내역 고유 식별자 (data-id 속성 또는 랜덤 생성값)" }
 *                       type: { type: string, example: "외출", description: "신청 유형 (외출 또는 외박)" }
 *                       duration: { type: string, example: "2026-05-29 17:00 ~ 2026-05-29 21:00", description: "출발 일시 ~ 귀교 일시 텍스트" }
 *                       reason: { type: string, example: "귀가", description: "외출·외박 신청 사유" }
 *                       status: { type: string, example: "대기", description: "현재 처리 상태 (승인 / 거절 / 대기)" }
 *       400:
 *         description: studentId 또는 token 쿼리 파라미터 누락
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "인증 인자 누락" }
 *       500:
 *         description: 원격 기숙사 서버 로그인 실패 또는 크롤링 파싱 런타임 오류
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "통합 내역 조회 내부 실패" }
 *                 error: { type: string, description: "실제 예외 메시지 (디버깅용)" }
 */
router.get('/applications', async (req, res) => {
    const { studentId, token } = req.query;
    if (!studentId || !token) {
        return res.status(400).json({ success: false, message: '인증 인자 누락' });
    }

    try {
        const cacheKey = `apps_${studentId}`;
        const cached = myCache.get(cacheKey);
        if (cached) return res.json(cached);

        const decryptedPw = "mockPassword123!";
        const client = await getAuthenticatedSession(studentId, decryptedPw);

        // 1. 면학 신청 목록 스크래핑
        const studyRes = await client.get(`${SCHOOL_BASE_URL}/Apply/study_list.php`);
        const $study = cheerio.load(studyRes.data);
        const studyHistory = [];

        $study('.table-responsive table tbody tr').each((_, el) => {
            const cols = $study(el).find('td');
            if (cols.length >= 6) {
                studyHistory.push({
                    id: $study(el).attr('data-id') || 'study_' + Math.random().toString(36).substr(2, 9),
                    date: $study(cols[0]).text().trim(),
                    time: $study(cols[1]).text().trim(),
                    place: $study(cols[2]).text().trim(),
                    teacher: $study(cols[3]).text().trim(),
                    reason: $study(cols[4]).text().trim(),
                    status: $study(cols[5]).text().trim()
                });
            }
        });

        // 2. 외출/외박 신청 목록 스크래핑
        const outRes = await client.get(`${SCHOOL_BASE_URL}/Apply/out_list.php`);
        const $out = cheerio.load(outRes.data);
        const outHistory = [];

        $out('.table-responsive table tbody tr').each((_, el) => {
            const cols = $out(el).find('td');
            if (cols.length >= 5) {
                outHistory.push({
                    id: $out(el).attr('data-id') || 'out_' + Math.random().toString(36).substr(2, 9),
                    type: $out(cols[0]).text().trim(), // 외출 또는 외박
                    duration: $out(cols[1]).text().trim(), // 나가는 일시 ~ 들어오는 일시
                    reason: $out(cols[2]).text().trim(),
                    status: $out(cols[3]).text().trim()
                });
            }
        });

        const mergedResult = { success: true, studyHistory, outHistory };
        myCache.set(cacheKey, mergedResult);
        res.json(mergedResult);
    } catch (error) {
        res.status(500).json({ success: false, message: '통합 내역 조회 내부 실패', error: error.message });
    }
});

/**
 * @swagger
 * /v1/applications/study:
 *   post:
 *     summary: 자율학습(면학) 신청 대행
 *     description: >
 *       클라이언트로부터 전달받은 면학 신청 정보(교시, 장소, 지도교사, 사유)를
 *       원본 기숙사 시스템의 `/Lib/study_apply.action.php`에 `mode=apply_insert`로
 *       폼 POST 전송하여 신청을 대행합니다. 처리 성공 시 해당 학생의 신청 내역
 *       관련 로컬 캐시(`apps_{studentId}`)를 강제 무효화합니다.
 *     tags: [Applications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId, token, studyTime, studyPlace, studyDetail, studyDetailReason]
 *             properties:
 *               studentId: { type: string, example: "s2024010101", description: "신청 대상 학생의 학번 아이디" }
 *               token: { type: string, example: "a1b2c3d4-e5f6-7g8h...", description: "클라이언트에 저장된 세션 검증용 UUID 토큰" }
 *               studyTime: { type: string, example: "1면학 (19:00 ~ 21:00)", description: "/v1/meta/options의 studyTimes 배열에서 선택한 교시 라벨 값" }
 *               studyPlace: { type: string, example: "본관 일반 교실", description: "/v1/meta/options의 studyPlaces 배열에서 선택한 장소 라벨 값" }
 *               studyDetail: { type: string, example: "홍길동 (국어)", description: "지도교사 이름. 원본 시스템의 supervisor 필드로 전달됩니다." }
 *               studyDetailReason: { type: string, example: "수학 선행 학습 및 문제 풀이", description: "면학 상세 사유. 원본 시스템의 apply_reason 필드로 전달됩니다." }
 *     responses:
 *       200:
 *         description: 면학 신청 원본 시스템 반영 완료 및 캐시 무효화 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "면학 신청이 정상적으로 원본 기숙사 사이트에 반영되었습니다." }
 *       500:
 *         description: 원격 기숙사 서버 로그인 실패 또는 폼 POST 네트워크 오류
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "면학 신청 통신 처리 에러" }
 */
router.post('/applications/study', async (req, res) => {
    const { studentId, token, studyTime, studyPlace, studyDetail, studyDetailReason } = req.body;
    try {
        const decryptedPw = "mockPassword123!";
        const client = await getAuthenticatedSession(studentId, decryptedPw);
        
        const actionUrl = `${SCHOOL_BASE_URL}/Lib/study_apply.action.php`;
        const params = new URLSearchParams({
            mode: 'apply_insert',
            study_time: studyTime,
            study_place: studyPlace,
            supervisor: studyDetail,
            apply_reason: studyDetailReason
        });

        const response = await client.post(actionUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        myCache.del(`apps_${studentId}`); // 캐시 무효화 처리 수행
        res.json({ success: true, message: '면학 신청이 정상적으로 원본 기숙사 사이트에 반영되었습니다.' });
    } catch (error) {
        res.status(500).json({ success: false, message: '면학 신청 통신 처리 에러' });
    }
});

/**
 * @swagger
 * /v1/applications/out:
 *   post:
 *     summary: 외출·외박 신청 대행
 *     description: >
 *       클라이언트로부터 전달받은 외출·외박 신청 정보(유형, 출발 일시, 귀교 일시, 사유)를
 *       원본 기숙사 시스템의 `/Lib/school_out.action.php`에 `mode=out_insert`로
 *       폼 POST 전송하여 신청을 대행합니다. 처리 성공 시 해당 학생의 신청 내역
 *       관련 로컬 캐시(`apps_{studentId}`)를 강제 무효화합니다.
 *     tags: [Applications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId, token, outType, outBdate, outBtime, outEdate, outEtime, outReason]
 *             properties:
 *               studentId: { type: string, example: "s2024010101", description: "신청 대상 학생의 학번 아이디" }
 *               token: { type: string, example: "a1b2c3d4-e5f6-7g8h...", description: "클라이언트에 저장된 세션 검증용 UUID 토큰" }
 *               outType: { type: string, example: "1", description: "신청 유형. 원본 시스템의 out_class 필드로 전달됩니다. (1: 외출, 2: 외박)" }
 *               outBdate: { type: string, example: "2026-05-29", description: "출발 날짜 (YYYY-MM-DD 형식). 원본 시스템의 begin_date 필드로 전달됩니다." }
 *               outBtime: { type: string, example: "17:00", description: "출발 시간 (HH:mm 형식). /v1/meta/options의 outTimes에서 선택한 값을 사용해야 합니다. 원본 시스템의 begin_time 필드로 전달됩니다." }
 *               outEdate: { type: string, example: "2026-05-29", description: "귀교 날짜 (YYYY-MM-DD 형식). 원본 시스템의 end_date 필드로 전달됩니다." }
 *               outEtime: { type: string, example: "21:00", description: "귀교 시간 (HH:mm 형식). /v1/meta/options의 outTimes에서 선택한 값을 사용해야 합니다. 원본 시스템의 end_time 필드로 전달됩니다." }
 *               outReason: { type: string, example: "서점 방문 및 도서 구매", description: "외출·외박 신청 사유. 원본 시스템의 out_reason 필드로 전달됩니다." }
 *     responses:
 *       200:
 *         description: 외출·외박 신청 원본 시스템 반영 완료 및 캐시 무효화 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "외출·외박 신청 처리가 완수되었습니다." }
 *       500:
 *         description: 원격 기숙사 서버 로그인 실패 또는 폼 POST 네트워크 오류
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "외출외박 처리 에러" }
 */
router.post('/applications/out', async (req, res) => {
    const { studentId, token, outType, outBdate, outBtime, outEdate, outEtime, outReason } = req.body;
    try {
        const decryptedPw = "mockPassword123!";
        const client = await getAuthenticatedSession(studentId, decryptedPw);

        const actionUrl = `${SCHOOL_BASE_URL}/Lib/school_out.action.php`;
        const params = new URLSearchParams({
            mode: 'out_insert',
            out_class: outType, // 1: 외출, 2: 외박
            begin_date: outBdate,
            begin_time: outBtime,
            end_date: outEdate,
            end_time: outEtime,
            out_reason: outReason
        });

        await client.post(actionUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        myCache.del(`apps_${studentId}`);
        res.json({ success: true, message: '외출·외박 신청 처리가 완수되었습니다.' });
    } catch (error) {
        res.status(500).json({ success: false, message: '외출외박 처리 에러' });
    }
});

/**
 * @swagger
 * /v1/applications/{type}/{id}:
 *   delete:
 *     summary: 신청 내역 취소/삭제
 *     description: >
 *       접수 또는 승인 대기 중인 특정 자율학습(면학) 또는 외출·외박 내역을 원본 기숙사
 *       시스템에서 영구 취소 처리합니다. type에 따라 호출 대상 액션 URL이 분기됩니다.
 *       (study → `/Lib/study_apply.action.php`, out → `/Lib/school_out.action.php`)
 *       원본 서버 응답에 `PERM_ERR`가 포함되면 403, `CHANGED_STATE_EXIST`가 포함되면 400을
 *       반환하며, 삭제 성공 시 캐시(`apps_{studentId}`)를 강제 무효화합니다.
 *     tags: [Applications]
 *     parameters:
 *       - in: path
 *         name: type
 *         required: true
 *         schema: { type: string, enum: [study, out] }
 *         description: "취소 대상 신청 종류 (자율학습은 study, 외출·외박은 out)"
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, example: "12543" }
 *         description: "원본 시스템의 del_items 값으로 사용되는 신청 내역 고유 행 번호 (GET /v1/applications 응답의 id 필드)"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId, token]
 *             properties:
 *               studentId: { type: string, example: "s2024010101", description: "삭제 요청 학생의 학번 아이디" }
 *               token: { type: string, example: "a1b2c3d4-e5f6-7g8h...", description: "클라이언트에 저장된 세션 검증용 UUID 토큰" }
 *     responses:
 *       200:
 *         description: 신청 내역 원본 시스템 삭제 완료 및 캐시 무효화 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "성공적으로 신청 정보가 파기되었습니다." }
 *       400:
 *         description: 원본 시스템에서 CHANGED_STATE_EXIST 반환 — 이미 관리자(사감)가 승인 또는 거절 처리하여 삭제 불가
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "이미 관리자가 승인 또는 거절 처리하여 화면에서 원격 삭제할 수 없습니다." }
 *       403:
 *         description: 원본 시스템에서 PERM_ERR 반환 — 세션 만료 또는 타인의 신청 내역에 접근 시도
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "권한 없음 혹은 세션 만료" }
 *       500:
 *         description: 원격 기숙사 서버 로그인 실패 또는 폼 POST 네트워크 런타임 오류
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: "백엔드 내부 연동 처리 실패" }
 */
router.delete('/applications/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const { studentId, token } = req.body;
    try {
        const decryptedPw = "mockPassword123!";
        const client = await getAuthenticatedSession(studentId, decryptedPw);
        
        const actionUrl = type === 'out' ? `${SCHOOL_BASE_URL}/Lib/school_out.action.php` : `${SCHOOL_BASE_URL}/Lib/study_apply.action.php`;
        const params = new URLSearchParams({ mode: 'apply_del', del_items: id });

        const response = await client.post(actionUrl, params.toString(), { 
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' } 
        });
        const text = String(response.data);

        if (text.includes('PERM_ERR')) return res.status(403).json({ success: false, message: '권한 없음 혹은 세션 만료' });
        if (text.includes('CHANGED_STATE_EXIST')) return res.status(400).json({ success: false, message: '이미 관리자가 승인 또는 거절 처리하여 화면에서 원격 삭제할 수 없습니다.' });
        
        myCache.del(`apps_${studentId}`);
        res.json({ success: true, message: '성공적으로 신청 정보가 파기되었습니다.' });
    } catch (error) {
        console.error("삭제 실패 로그:", error);
        res.status(500).json({ success: false, message: '백엔드 내부 연동 처리 실패' });
    }
});

export default router;
