const admin = require('firebase-admin');
// 이미 다른 파일에서 admin.initializeApp()을 했다고 가정합니다.
const db = admin.firestore();

// 📌 동적 API 키 및 도메인 검증 미들웨어
const verifyDeveloperApiKey = async (req, res, next) => {
    // 1. 헤더에서 API 키 추출
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({ 
            success: false, 
            code: 'MISSING_API_KEY', 
            message: '요청 헤더에 x-api-key가 포함되어야 합니다.' 
        });
    }

    try {
        // 2. Firestore에서 해당 API 키 문서 조회
        const devDoc = await db.collection('developers').doc(apiKey).get();

        if (!devDoc.exists) {
            return res.status(403).json({ 
                success: false, 
                code: 'INVALID_API_KEY', 
                message: '유효하지 않거나 폐기된 API 키입니다.' 
            });
        }

        const developerData = devDoc.data();

        // 3. 계정 활성화 상태 체크 (정지된 개발자 차단)
        if (developerData.isActive === false) {
            return res.status(403).json({ 
                success: false, 
                code: 'ACCOUNT_SUSPENDED', 
                message: '사용이 정지된 API 키입니다.' 
            });
        }

        // 4. CORS 및 도메인 화이트리스트 검증
        const origin = req.headers.origin;
        const allowedDomains = developerData.allowedDomains || [];
        
        // origin이 존재하고(브라우저 요청), 허용 도메인 목록이 설정되어 있을 경우에만 검사
        if (origin && allowedDomains.length > 0 && !allowedDomains.includes(origin)) {
            return res.status(403).json({ 
                success: false, 
                code: 'BLOCKED_DOMAIN', 
                message: `등록되지 않은 도메인(${origin})에서의 접근입니다.` 
            });
        }

        // 5. 검증 완료: 다음 라우터에서 쓸 수 있도록 req 객체에 개발자 정보 저장
        req.developer = developerData;
        req.apiKey = apiKey;
        
        // 다음 단계(실제 API 로직)로 넘김
        next();

    } catch (error) {
        console.error('API Key 검증 서버 에러:', error);
        return res.status(500).json({ 
            success: false, 
            code: 'INTERNAL_AUTH_ERROR',
            message: '인증 서버 내부 오류가 발생했습니다.' 
        });
    }
};

module.exports = { verifyDeveloperApiKey };
