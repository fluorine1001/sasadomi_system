import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import rateLimit from 'express-rate-limit'; // 🟢 1. 속도 제한 라이브러리 추가
import 'dotenv/config';

// 🟢 방금 만든 라우터 파일 임포트
import v1Router from './routes/v1.js';

const app = express();

// 🟢 2. 속도 제한 설정 (API Key 기준)
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1분 동안
    max: 30, // 최대 30회까지만 요청 허용
    keyGenerator: (req) => req.headers['x-api-key'] || req.ip, // IP 대신 API Key를 기준으로 카운트
    message: { 
        success: false, 
        message: '요청 한도를 초과했습니다. 1분 후에 다시 시도해 주세요. (Too Many Requests)' 
    }
});

app.use(cors({
    origin: '*', 
    methods: ['POST', 'GET', 'OPTIONS', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json());

// 🟢 3. 모든 /v1 하위 라우터에 속도 제한 미들웨어 적용
app.use('/v1', apiLimiter, verifyDeveloperApiKey, v1Router(db, admin));

// Firebase DB 초기화
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

// 🟢 API Key 검증 미들웨어
const verifyDeveloperApiKey = async (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ success: false, message: 'API Key 누락' });
    
    try {
        const keyDoc = await db.collection('developers').doc(apiKey).get();
        if (!keyDoc.exists) return res.status(403).json({ success: false, message: '유효하지 않은 API Key' });
        if (keyDoc.data().isActive === false) return res.status(403).json({ success: false, message: '사용 정지된 API Key' });
        
        req.developer = keyDoc.data();
        next();
    } catch (error) {
        res.status(500).json({ success: false, message: '인증 서버 오류' });
    }
};

app.get('/', (req, res) => {
    res.send('🚀 Sasadomi System Public API Hub is running!');
});

// 🟢 라우터 결합 (v1Router 함수에 db 객체를 넘겨주고 생성된 라우터를 사용)
app.use('/v1', verifyDeveloperApiKey, v1Router(db));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`공용 오픈 API 서버 작동 중 :: 포트 ${PORT}`));
