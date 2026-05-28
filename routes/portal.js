import express from 'express';
import crypto from 'crypto';

export default function portalRouter(db, admin) {
    const router = express.Router();

    // 🔒 [미들웨어] 프론트엔드가 보낸 Firebase JWT 토큰(IdToken) 검증
    const verifyPortalUser = async (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: '인증 토큰이 누락되었습니다.' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        try {
            // Firebase Auth 토큰 직접 검증 (실무 보안 규격)
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            req.portalUser = decodedToken; // 유저 정보(uid, email 등) 주입
            next();
        } catch (error) {
            return res.status(403).json({ success: false, code: 'INVALID_TOKEN', message: '만료되거나 올바르지 않은 토큰입니다.' });
        }
    };

    // 📌 1. 내 API 키 및 설정 조회
    router.get('/my-key', verifyPortalUser, async (req, res) => {
        try {
            const { uid } = req.portalUser;
            // uid 필드로 해당 개발자의 API 키 조회
            const snapshot = await db.collection('developers').where('uid', '==', uid).limit(1).get();
            
            if (snapshot.empty) {
                return res.json({ success: true, hasKey: false });
            }

            const doc = snapshot.docs[0];
            res.json({
                success: true,
                hasKey: true,
                apiKey: doc.id, // 문서 ID가 곧 API 키
                allowedDomains: doc.data().allowedDomains || [],
                isActive: doc.data().isActive
            });
        } catch (error) {
            res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
        }
    });

    // 📌 2. API 키 신규 발급 또는 재발급 (기존 키가 있으면 대체)
    router.post('/issue-key', verifyPortalUser, async (req, res) => {
        try {
            const { uid, email } = req.portalUser;

            // 1) 기존에 발급된 키가 있다면 구형 키 문서 삭제 (1인 1키 원칙)
            const oldKeys = await db.collection('developers').where('uid', '==', uid).get();
            const batch = db.batch();
            oldKeys.forEach(doc => batch.delete(doc.ref));
            await batch.commit();

            // 2) 암호학적으로 안전한 새 API 키 생성 (실무 규격 접두사 포함)
            const newApiKey = 'sasa_dev_' + crypto.randomBytes(24).toString('hex');

            // 3) 키를 문서 ID로 하여 Firestore에 저장 (미들웨어 O(1) 조회를 위함)
            await db.collection('developers').doc(newApiKey).set({
                uid,
                email,
                allowedDomains: [],
                isActive: true,
                createdAt: new Date()
            });

            res.status(201).json({ success: true, apiKey: newApiKey });
        } catch (error) {
            res.status(500).json({ success: false, message: '키 발급 중 오류가 발생했습니다.' });
        }
    });

    // 📌 3. CORS 보안을 위한 허용 도메인(화이트리스트) 업데이트
    router.post('/update-domains', verifyPortalUser, async (req, res) => {
        const { apiKey, allowedDomains } = req.body; // 배열 형태의 도메인 리스트
        const { uid } = req.portalUser;

        if (!Array.isArray(allowedDomains)) {
            return res.status(400).json({ success: false, message: '올바른 도메인 리스트 형식이 아닙니다.' });
        }

        try {
            const keyDocRef = db.collection('developers').doc(apiKey);
            const doc = await keyDocRef.get();

            if (!doc.exists || doc.data().uid !== uid) {
                return res.status(403).json({ success: false, message: '수정 권한이 없거나 존재하지 않는 키입니다.' });
            }

            // 도메인 화이트리스트 저장 (프로토콜 포함 규격 예외처리 등은 프론트/백 더블체크)
            const cleanedDomains = allowedDomains.map(d => d.trim().replace(/\/$/, '')).filter(Boolean);

            await keyDocRef.update({ allowedDomains: cleanedDomains });
            res.json({ success: true, message: '허용 도메인이 업데이트되었습니다.' });
        } catch (error) {
            res.status(500).json({ success: false, message: '도메인 업데이트 중 오류가 발생했습니다.' });
        }
    });

    return router;
}
