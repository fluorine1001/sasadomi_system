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
 * get:
 * summary: 상벌점 데이터 별도 실시간 조회
 * description: 학교 기숙사 서버로부터 사용자의 상점 및 벌점 데이터 테이블을 실시간으로 크롤링하여 총점 및 세부 내역을 파싱합니다.
 * parameters:
 * - in: query
 * name: studentId
 * required: true
 * schema:
 * type: string
 * description: 학생 학번/아이디
 * - in: query
 * name: token
 * required: true
 * schema:
 * type: string
 * description: 클라이언트 세션 검증 토큰
 * responses:
 * 200:
 * description: 상벌점 데이터 조회 및 파싱 성공
 * content:
 * application/json:
 * schema:
 * type: object
 * properties:
 * success: { type: boolean, example: true }
 * rewardScore: { type: number, example: 5 }
 * penaltyScore: { type: number, example: 0 }
 * pointsHistory:
 * type: array
 * items:
 * type: object
 * properties:
 * date: { type: string, example: "2026-05-12" }
 * type: { type: string, example: "상점" }
 * score: { type: number, example: 2 }
 * reason: { type: string, example: "기숙사 호실 청소 상태 우수" }
 * 400:
 * description: 필수 요청 쿼리 매개변수 누락 오류
 * 500:
 * description: 백엔드 내부 연동 및 런타임 오류
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
 * get:
 * summary: 폼 드롭다운 입력 양식용 메타데이터 조회
 * description: 면학 신청 장소, 시간, 담당 교사 및 외출 시간대 옵션 데이터를 JSON 구조로 일괄 반환합니다.
 * responses:
 * 200:
 * description: 메타데이터 배열 획득 성공
 * content:
 * application/json:
 * schema:
 * type: object
 * properties:
 * success: { type: boolean, example: true }
 * studyTimes: { type: array, items: { type: string } }
 * studyPlaces: { type: array, items: { type: string } }
 * teachers: { type: array, items: { type: string } }
 * outTimes: { type: array, items: { type: string } }
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
 * get:
 * summary: 면학/외출외박 통합 신청 내역 이력 조회
 * description: 학교 원본 시스템 페이지를 스크래핑하여 면학실 이용 정보와 외출·외박 상태를 통합 배열로 구성하여 리턴합니다.
 * parameters:
 * - in: query
 * name: studentId
 * required: true
 * schema:
 * type: string
 * - in: query
 * name: token
 * required: true
 * schema:
 * type: string
 * responses:
 * 200:
 * description: 전체 신청 내역 병합 리턴 성공
 * content:
 * application/json:
 * schema:
 * type: object
 * properties:
 * success: { type: boolean, example: true }
 * studyHistory: { type: array, items: { type: object } }
 * outHistory: { type: array, items: { type: object } }
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
 * post:
 * summary: 본관/자가면학실 실시간 등록 신청
 * description: 프론트엔드 입력 데이터를 규격에 맞춰 원본 기숙사 액션 처리 PHP 파일에 가상으로 FORM POST 처리합니다.
 * requestBody:
 * required: true
 * content:
 * application/json:
 * schema:
 * type: object
 * required: [studentId, token, studyTime, studyPlace, studyDetail, studyDetailReason]
 * properties:
 * studentId: { type: string }
 * token: { type: string }
 * studyTime: { type: string }
 * studyPlace: { type: string }
 * studyDetail: { type: string }
 * studyDetailReason: { type: string }
 * responses:
 * 200:
 * description: 면학 신청 정상 접수 완료
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
 * post:
 * summary: 외출 또는 외박 신청서 제출
 * description: 입력한 기간, 시간, 목적 사유를 바인딩하여 외출외박 접수를 대행합니다.
 * requestBody:
 * required: true
 * content:
 * application/json:
 * schema:
 * type: object
 * required: [studentId, token, outType, outBdate, outBtime, outEdate, outEtime, outReason]
 * responses:
 * 200:
 * description: 외출외박 접수 완료
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
 * /v1/applications/:type/:id:
 * delete:
 * summary: 기 접수된 신청 내역의 원격 취소 및 삭제
 * description: 상태값 검증을 포함하여 아직 확정(승인/거절)되지 않은 신청 건을 삭제 모드로 포스팅 요청을 보내 즉각 드롭합니다.
 * parameters:
 * - in: path
 * name: type
 * required: true
 * schema:
 * type: string
 * description: 신청 종류 구분구값 (study 또는 out)
 * - in: path
 * name: id
 * required: true
 * schema:
 * type: string
 * description: 원본 데이터 고유 행 일련번호(del_items 번호)
 * responses:
 * 200:
 * description: 원격 취소 원본 삭제 처리 성공
 * 400:
 * description: 이미 상태가 승인/거절로 변경되어 삭제 불가능한 상태 상태 코드
 * 403:
 * description: 세션 만료 또는 권한 미달 제어 실패
 * 500:
 * description: 백엔드 내부 예외처리 런타임 오류
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
