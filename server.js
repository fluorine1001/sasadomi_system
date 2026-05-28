import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

import v1Router from './routes/v1.js';

const app = express();

app.set('trust proxy', 1);

app.use(cors({
    origin: '*', 
    methods: ['POST', 'GET', 'OPTIONS', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));

app.options(/.*/, cors()); 

// 🟢 [수정됨] IPv6 파싱 에러 방지를 위해 req.ip 제거
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.headers['x-api-key'] || 'anonymous_user',
    message: { success: false, message: '요청 한도를 초과했습니다. 1분 후에 다시 시도해 주세요.' }
});

app.use(express.json());

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

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: "Sasadomi API Docs"
}));

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

const verifyDeveloperApiKey = async (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
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

app.use('/v1', apiLimiter, verifyDeveloperApiKey, v1Router(db, admin));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`공용 오픈 API 서버 작동 중 :: 포트 ${PORT}`));
