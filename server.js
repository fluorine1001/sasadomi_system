import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

import v1Router from './routes/v1.js';
// 🟢 [추가됨] 개발자 포털 전용 라우터 불러오기
import portalRouter from './routes/portal.js'; 

const app = express();

app.set('trust proxy', 1);

app.options(/.*/, cors()); 

// 🟢 [3단계 처리량 제한] 에러 코드 표준화 적용 (TOO_MANY_REQUESTS)
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.headers['x-api-key'] || 'anonymous_user',
    message: { 
        success: false, 
        code: 'TOO_MANY_REQUESTS', 
        message: '요청 한도를 초과했습니다. 1분 후에 다시 시도해 주세요.' 
    }
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

// 🟢 [Vercel 완벽 호환] swagger-ui-express 내부 로컬 정적파일 로더를 우회하여 순수 HTML과 외부 CDN으로 화면 렌더링
app.get('/api-docs', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <title>Sasadomi API Docs</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css" />
        <style>
            html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
            *, *:before, *:after { box-sizing: inherit; }
            body { margin: 0; background: #fafafa; }
        </style>
    </head>
    <body>
        <div id="swagger-ui"></div>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-standalone-preset.js"></script>
        <script>
            window.onload = function() {
                window.ui = SwaggerUIBundle({
                    spec: ${JSON.stringify(swaggerSpec)},
                    dom_id: '#swagger-ui',
                    deepLinking: true,
                    presets: [
                        SwaggerUIBundle.presets.apis,
                        SwaggerUIStandalonePreset
                    ],
                    layout: "StandaloneLayout"
                });
            };
        </script>
    </body>
    </html>`;
    res.send(html);
});

// 🟢 [추가됨] LLM 및 AI 에이전트가 API 구조를 즉시 파악할 수 있도록 순수 OpenAPI Spec JSON 엔드포인트 개방
app.get('/api-json', (req, res) => {
    res.json(swaggerSpec);
});

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

// 🟢 [1단계/4단계] 에러 코드 표준화 적용 및 불필요한 api-docs 조건문 제거
const verifyDeveloperApiKey = async (req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ 
            success: false, 
            code: 'MISSING_API_KEY', 
            message: 'API Key가 누락되었습니다.' 
        });
    }
    
    try {
        const keyDoc = await db.collection('developers').doc(apiKey).get();
        if (!keyDoc.exists) {
            return res.status(403).json({ 
                success: false, 
                code: 'INVALID_API_KEY', 
                message: '유효하지 않은 API Key입니다.' 
            });
        }
        if (keyDoc.data().isActive === false) {
            return res.status(403).json({ 
                success: false, 
                code: 'SUSPENDED_API_KEY', 
                message: '사용 정지된 API Key입니다.' 
            });
        }
        
        req.developer = keyDoc.data();
        next();
    } catch (error) {
        console.error("인증 에러:", error);
        res.status(500).json({ 
            success: false, 
            code: 'SERVER_ERROR', 
            message: '인증 서버 오류가 발생했습니다.' 
        });
    }
};

app.get('/', (req, res) => {
    res.send('🚀 Sasadomi System Public API Hub is running!');
});

// 🟢 오픈 API v1 라우터 바인딩 (기존)
app.use('/v1', apiLimiter, verifyDeveloperApiKey, v1Router(db, admin));

// 🟢 [추가됨] 외부 개발자 전용 포털 관리 라우터 바인딩
app.use('/portal', portalRouter(db, admin)); 

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`공용 오픈 API 서버 작동 중 :: 포트 ${PORT}`));
