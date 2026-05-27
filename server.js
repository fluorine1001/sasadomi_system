import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

// 🟢 Swagger 관련 패키지 불러오기
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

import v1Router from './routes/v1.js';

const app = express();

// 🟢 속도 제한 설정 (API Key 기준)
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1분 동안
    max: 30, // 최대 30회 허용
    keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
    message: { success: false, message: '요청 한도를 초과했습니다. 1분 후에 다시 시도해 주세요.' }
});

app.use(cors({
    origin: '*', 
    methods: ['POST', 'GET', 'OPTIONS', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json());

// 🟢 Swagger API 문서 기본 정보 설정
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Sasadomi API',
            version: '1.0.0',
            description: '사사도미(Sasadomi) 비공식 REST API 사용 설명서 및 테스트 도구입니다.',
        },
        components: {
            securitySchemes: {
                ApiKeyAuth: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-api-key',
                    description: '발급받은 API Key를 입력하세요.'
                }
            }
        },
        security: [{ ApiKeyAuth: [] }]
    },
    // routes 폴더 안의 모든 js 파일에서 주석을 읽어와 문서를 생성합니다.
    apis: ['./routes/*.js'], 
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);

// 🟢 /api-docs 경로로 접속 시 Swagger UI 제공
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: "Sasadomi API Docs"
}));

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
    
    // api-docs(문서 페이지) 접속은 API Key 검증을 면제합니다. (누구나 문서는 볼 수 있어야 하므로)
    if (req.path.startsWith('/api-docs')) return next();

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

// 🟢 모든 /v1 하위 라우터에 속도 제한 및 인증 미들웨어 적용
app.use('/v1', apiLimiter, verifyDeveloperApiKey, v1Router(db, admin));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`공용 오픈 API 서버 작동 중 :: 포트 ${PORT}`));
