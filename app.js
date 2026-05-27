// Render에 배포한 본인의 API 주소로 연동
const BACKEND_API_URL = 'https://sasadomi-system.vercel.app/';

let currentStudentId = '';

// 📌 페이지 로드 시 토큰 기반 자동 로그인 시도
window.addEventListener('DOMContentLoaded', () => {
    const savedToken = localStorage.getItem('sasa_sessionToken');
    
    if (savedToken) {
        document.getElementById('rememberMe').checked = true;
        autoLogin(savedToken);
    }
});

// [기능] 토큰을 이용한 자동 로그인
async function autoLogin(token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/api/auto-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });

        const data = await res.json();
        
        if (data.success) {
            currentStudentId = data.studentId;
            renderDashboard(data);
        } else {
            // 토큰이 만료되었거나 유효하지 않으면 로컬 데이터 정리
            clearSession();
        }
    } catch (error) {
        console.error('자동 로그인 실패:', error);
    }
}

// [기능] 계정 연동 및 데이터 패치 (최초 로그인)
async function syncAccount() {
    const studentId = document.getElementById('studentId').value;
    const studentPw = document.getElementById('studentPw').value;
    const grade = document.getElementById('grade').value;
    const sclass = document.getElementById('sclass').value;
    const number = document.getElementById('number').value;

    if (!studentId || !studentPw) return alert('아이디와 패스워드를 적어주세요.');

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/login-and-fetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId, studentPw, grade, sclass, number })
        });

        const data = await res.json();
        
        if (data.success) {
            currentStudentId = studentId;

            // 💡 실무 보안: 비밀번호 대신 백엔드에서 발급한 '세션 토큰'만 저장
            if (document.getElementById('rememberMe') && document.getElementById('rememberMe').checked) {
                localStorage.setItem('sasa_sessionToken', data.sessionToken);
            } else {
                clearSession();
            }

            renderDashboard(data);
            alert('성공적으로 계정이 연동 및 최신 데이터 동기화 완료되었습니다.');
        } else {
            alert(data.message || '인증 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// 📌 대시보드 UI 렌더링 분리 (재사용성을 위해)
function renderDashboard(data) {
    document.getElementById('rewardView').innerText = data.totalReward;
    document.getElementById('penaltyView').innerText = data.totalPenalty;

    const rewards = (data.rewardList || []).map(item => ({ ...item, type: '상점', color: '#1890ff' }));
    const penalties = (data.penaltyList || []).map(item => ({ ...item, type: '벌점', color: '#ff4d4f' }));
    const combinedList = [...rewards, ...penalties];

    const tbody = document.querySelector('#historyTable tbody');
    tbody.innerHTML = '';
    
    combinedList.forEach(item => {
        tbody.innerHTML += `<tr>
            <td style="color: ${item.color}; font-weight: bold;">${item.type}</td>
            <td>${item.score}</td>
            <td>${item.weight}</td>
            <td>${item.reason}</td>
            <td>${item.date}</td>
        </tr>`;
    });

    document.getElementById('dashboard').style.display = 'block';
}

// 📌 세션 초기화 유틸리티
function clearSession() {
    localStorage.removeItem('sasa_sessionToken');
}

// [기능] 자율학습 장소 변경 이벤트 핸들러 (본관 전용 조건부 필드 제어)
function toggleStudyFields(placeValue) {
    const conditionalBox = document.getElementById('conditionalStudyFields');
    if (placeValue === '3') { // 본관 선택 코드값 '3'
        conditionalBox.style.display = 'block';
    } else {
        conditionalBox.style.display = 'none';
    }
}

// [기능] 자율학습 신청 제출
async function submitStudy() {
    const rawDate = document.getElementById('studyDate').value;
    const time = document.getElementById('studyTime').value;
    const place = document.getElementById('studyPlace').value;
    
    if (!rawDate) return alert('날짜를 지정해 주세요.');
    
    const dateObj = new Date(rawDate + 'T00:00:00');
    const timestampSeconds = Math.floor(dateObj.getTime() / 1000);

    const payload = {
        studentId: currentStudentId,
        date: timestampSeconds,
        time: time,
        place: place
    };

    if (place === '3') {
        payload.detail = document.getElementById('studyDetail').value;
        payload.detail_reason = document.getElementById('studyDetailReason').value;
        if (!payload.detail_reason) return alert('본관 사유를 기록해 주세요.');
    }

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/apply-study`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
            alert('자율학습 신청 대행 요청이 처리되었습니다!');
            closeModal('studyModal');
        } else {
            alert(data.message || '신청 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// [기능] 외출 외박 신청 제출
async function submitOut() {
    const outType = document.getElementById('outType').value;
    const outReason = document.getElementById('outReason').value;
    const bDateInput = document.getElementById('outBdate').value;
    const bTimeInput = document.getElementById('outBtime').value;
    const eDateInput = document.getElementById('outEdate').value;
    const eTimeInput = document.getElementById('outEtime').value;

    if (!bDateInput || !eDateInput || !outReason) return alert('필수 항목을 빠짐없이 기입해 주세요.');

    const bdateSec = Math.floor(new Date(`${bDateInput}T${bTimeInput}:00`).getTime() / 1000);
    const edateSec = Math.floor(new Date(`${eDateInput}T${eTimeInput}:00`).getTime() / 1000);

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/apply-out`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                studentId: currentStudentId,
                type: outType,
                reason: outReason,
                bdate: bdateSec,
                edate: edateSec
            })
        });

        const data = await res.json();
        if (data.success) {
            alert('외출/외박 신청 연동 처리가 수락되었습니다.');
            closeModal('outModal');
        } else {
            alert(data.message || '신청 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// 📌 [기능] 계정 연동 해제
async function disconnectAccount() {
    if (!currentStudentId) return alert('현재 연동된 계정이 없습니다.');
    
    if (!confirm('정말 계정 연동을 해제하시겠습니까?\n저장된 자동 로그인 정보가 즉시 삭제됩니다.')) return;

    const savedToken = localStorage.getItem('sasa_sessionToken');

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/disconnect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId: currentStudentId, token: savedToken })
        });

        const data = await res.json();
        
        if (data.success) {
            alert('계정 연동이 안전하게 해제되었습니다.');
            
            // 데이터 및 UI 초기화
            clearSession();
            currentStudentId = '';
            document.getElementById('dashboard').style.display = 'none';
            document.getElementById('studentId').value = '';
            document.getElementById('studentPw').value = '';
            document.getElementById('grade').value = '';
            document.getElementById('sclass').value = '';
            document.getElementById('number').value = '';
            if (document.getElementById('rememberMe')) document.getElementById('rememberMe').checked = false;
            
            document.getElementById('rewardView').innerText = '0';
            document.getElementById('penaltyView').innerText = '0';
            document.querySelector('#historyTable tbody').innerHTML = '';
            
            closeModal('studyModal');
            closeModal('outModal');
        } else {
            alert(data.message || '연동 해제 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// 모달 제어 유틸리티
function openModal(id) { document.getElementById(id).style.display = 'block'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
