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

// 🟢 [핵심 추가] Vercel 같은 클라우드 환경에서 프록시(Proxy)를 거친 IP를 정상 인식하도록 설정
app.set('trust proxy', 1);

// 🟢 CORS 설정 및 브라우저의 사전 요청(OPTIONS) 명시적 완전 허용
app.use(cors({
    origin: '*', 
    methods: ['POST', 'GET', 'OPTIONS', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));

// 🟢 [핵심 수정] Express 5.0 호환을 위해 '*' 문자열 대신 정규표현식 /.*/ 사용으로 변경
app.options(/.*/, cors()); 

// 🟢 속도 제한 설정 (API Key 기준)
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1분 동안
    max: 30, // 최대 30회 허용
    keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
    message: { success: false, message: '요청 한도를 초과했습니다. 1분 후에 다시 시도해 주세요.' }
});

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
    // OPTIONS 요청은 위에서 cors()가 처리하더라도 확실히 넘어가도록 이중 방어
    if (req.method === 'OPTIONS') return next();
    
    // api-docs(문서 페이지) 접속은 API Key 검증 면제
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
        console.error("인증 에러:", error);
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
