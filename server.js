import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import 'dotenv/config';

// 🟢 방금 만든 라우터 파일 임포트
import v1Router from './routes/v1.js';

const app = express();

app.use(cors({
    origin: '*', 
    methods: ['POST', 'GET', 'OPTIONS', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json());

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
