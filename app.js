// Render 또는 Vercel에 배포한 본인의 API 주소로 연동
const BACKEND_API_URL = 'https://sasadomi-system.vercel.app';

// 백엔드와 맞춘 API Key (Firebase Firestore의 api_keys 컬렉션에 등록한 문서 ID와 똑같이 적어줘!)
const SASADOMI_API_KEY = '1MANmgyI4BbFbN2vq95K'; 

let currentStudentId = '';
let currentSessionToken = ''; // 로그인 세션 토큰을 메모리에 안전하게 유지할 전역 변수

// 📌 페이지 로드 시 토큰 기반 자동 로그인 시도
window.addEventListener('DOMContentLoaded', () => {
    const savedToken = localStorage.getItem('sasa_sessionToken');
    
    if (savedToken) {
        if (document.getElementById('rememberMe')) {
            document.getElementById('rememberMe').checked = true;
        }
        autoLogin(savedToken);
    }
});

// 토큰을 이용한 자동 로그인
async function autoLogin(token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/api/auto-login`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-api-key': SASADOMI_API_KEY 
            },
            body: JSON.stringify({ token })
        });

        const data = await res.json();
        
        if (data.success) {
            currentStudentId = data.studentId;
            currentSessionToken = token;
            
            const loginForm = document.getElementById('loginForm');
            if (loginForm) loginForm.style.display = 'none';

            renderDashboard(data);
            
            // 🟢 자동 로그인 성공 시 신청 내역 불러오기 추가
            fetchApplications(currentStudentId, currentSessionToken);
        } else {
            clearSession();
        }
    } catch (error) {
        console.error('자동 로그인 실패:', error);
    }
}

// 📌 계정 연동 및 데이터 패치 (최초 로그인) - 학번 자동 파싱 로직 적용
async function syncAccount() {
    const rawStudentId = document.getElementById('studentId').value;
    const studentPw = document.getElementById('studentPw').value;

    if (!rawStudentId || !studentPw) return alert('아이디와 패스워드를 적어주세요.');

    // 🟢 입력값 정리 및 소문자 변환
    const studentId = rawStudentId.trim().toLowerCase();

    // 🟢 아이디 양식 검증 (길이가 11자리이고 's'로 시작하는지)
    if (studentId.length !== 11 || !studentId.startsWith('s')) {
        return alert('올바른 학번 양식(s년도학년반번호)으로 입력해 주세요.\n예: s2026030601');
    }

    // 🟢 아이디 문자열 슬라이싱 및 앞자리 0 제거 파싱
    // 예: 's2026030601' -> grade: '3', sclass: '6', number: '1'
    const grade = parseInt(studentId.substring(5, 7), 10).toString();
    const sclass = parseInt(studentId.substring(7, 9), 10).toString();
    const number = parseInt(studentId.substring(9, 11), 10).toString();

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/login-and-fetch`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-api-key': SASADOMI_API_KEY 
            },
            // 파싱한 데이터(grade, sclass, number)를 함께 백엔드로 전송
            body: JSON.stringify({ studentId, studentPw, grade, sclass, number })
        });

        const data = await res.json();
        
        if (data.success) {
            currentStudentId = studentId;
            currentSessionToken = data.sessionToken;

            if (document.getElementById('rememberMe') && document.getElementById('rememberMe').checked) {
                localStorage.setItem('sasa_sessionToken', data.sessionToken);
            } else {
                clearSession();
            }

            const loginForm = document.getElementById('loginForm');
            if (loginForm) loginForm.style.display = 'none';

            renderDashboard(data);
            
            // 🟢 계정 연동(로그인) 성공 시 신청 내역 불러오기 추가
            fetchApplications(currentStudentId, currentSessionToken);
            
            alert('성공적으로 계정이 연동 및 최신 데이터 동기화 완료되었습니다.');
        } else {
            alert(data.message || '인증 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// 📌 대시보드 UI 렌더링 분리
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

// 자율학습 장소 변경 이벤트 핸들러
function toggleStudyFields(placeValue) {
    const conditionalBox = document.getElementById('conditionalStudyFields');
    if (placeValue === '3') {
        conditionalBox.style.display = 'block';
    } else {
        conditionalBox.style.display = 'none';
    }
}

// 자율학습 신청 제출
async function submitStudy() {
    const rawDate = document.getElementById('studyDate').value;
    const time = document.getElementById('studyTime').value;
    const place = document.getElementById('studyPlace').value;
    
    if (!rawDate) return alert('날짜를 지정해 주세요.');
    
    const dateObj = new Date(rawDate + 'T00:00:00');
    const timestampSeconds = Math.floor(dateObj.getTime() / 1000);

    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');

    const payload = {
        studentId: currentStudentId,
        token: activeToken,
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
            headers: { 
                'Content-Type': 'application/json',
                'x-api-key': SASADOMI_API_KEY 
            },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
            alert('자율학습 신청 대행 요청이 처리되었습니다!');
            closeModal('studyModal');
            
            // 🟢 신청 완료 후 내역 테이블 최신화
            fetchApplications(currentStudentId, activeToken);
        } else {
            alert(data.message || '신청 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// 외출 외박 신청 제출
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

    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/apply-out`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-api-key': SASADOMI_API_KEY 
            },
            body: JSON.stringify({
                studentId: currentStudentId,
                token: activeToken,
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
            
            // 🟢 신청 완료 후 내역 테이블 최신화
            fetchApplications(currentStudentId, activeToken);
        } else {
            alert(data.message || '신청 실패');
        }
    } catch (error) {
        console.error(error);
        alert('서버 통신 중 오류가 발생했습니다.');
    }
}

// 계정 연동 해제
async function disconnectAccount() {
    if (!currentStudentId) return alert('현재 연동된 계정이 없습니다.');
    
    if (!confirm('정말 계정 연동을 해제하시겠습니까?\n저장된 자동 로그인 정보가 즉시 삭제됩니다.')) return;

    const savedToken = localStorage.getItem('sasa_sessionToken');

    try {
        const res = await fetch(`${BACKEND_API_URL}/api/disconnect`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-api-key': SASADOMI_API_KEY 
            },
            body: JSON.stringify({ studentId: currentStudentId, token: savedToken })
        });

        const data = await res.json();
        
        if (data.success) {
            alert('계정 연동이 안전하게 해제되었습니다.');
            
            clearSession();
            currentStudentId = '';
            currentSessionToken = '';
            document.getElementById('dashboard').style.display = 'none';
            
            const loginForm = document.getElementById('loginForm');
            if (loginForm) loginForm.style.display = 'block';

            document.getElementById('studentId').value = '';
            document.getElementById('studentPw').value = '';
            if (document.getElementById('rememberMe')) document.getElementById('rememberMe').checked = false;
            
            document.getElementById('rewardView').innerText = '0';
            document.getElementById('penaltyView').innerText = '0';
            document.querySelector('#historyTable tbody').innerHTML = '';
            
            // 🟢 연동 해제 시 신청 내역 테이블도 초기화
            document.querySelector('#studyHistoryTable tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;">내역을 불러오는 중...</td></tr>';
            document.querySelector('#outHistoryTable tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;">내역을 불러오는 중...</td></tr>';
            
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


// 📌 신청 내역 API 통신 로직 (Vercel 백엔드 파이프라인 유지)
async function fetchApplications(studentId, token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/api/fetch-applications`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': SASADOMI_API_KEY
            },
            body: JSON.stringify({ studentId, token })
        });
        
        const data = await res.json();
        
        if (data.success) {
            // 🟢 백엔드에서 데이터 가공 시 분석한 고유 ID(value)가 item.id로 들어있어야 삭제 연동이 가능합니다.
            renderStudyList(data.studyList);
            renderOutList(data.outList);
        } else {
            console.error("신청 내역 조회 실패:", data.message);
        }
    } catch (error) {
        console.error("신청 내역 통신 오류:", error);
    }
}

// 📌 자율학습 리스트 렌더링 (분석한 데이터 기반 삭제 버튼 기능 이식)
function renderStudyList(list) {
    const tbody = document.querySelector('#studyHistoryTable tbody');
    tbody.innerHTML = '';
    
    if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#999;">신청 내역이 없습니다.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${item.date}</td>
            <td>${item.time}</td>
            <td>${item.place}</td>
            <td>${item.detail || '없음'}</td>
            <td>
                <span class="status-badge">${item.status}</span>
                <button onclick="deleteApplication('study', '${item.id}')" style="margin-left:8px; padding:3px 8px; background:#ff4d4f; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">삭제</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// 📌 외출/외박 리스트 렌더링 (분석한 데이터 기반 삭제 버튼 기능 이식)
function renderOutList(list) {
    const tbody = document.querySelector('#outHistoryTable tbody');
    tbody.innerHTML = '';
    
    if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#999;">신청 내역이 없습니다.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${item.type}</strong></td>
            <td>${item.reason}</td>
            <td>${item.outDate}</td>
            <td>${item.inDate}</td>
            <td>
                <span class="status-badge">${item.status}</span>
                <button onclick="deleteApplication('out', '${item.id}')" style="margin-left:8px; padding:3px 8px; background:#ff4d4f; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">삭제</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// 📌 [신규 추가] 분석된 삭제 프로토콜 전송 함수 (Vercel 백엔드 경유형)
async function deleteApplication(type, id) {
    if (!id || id === 'undefined' || id === '') {
        alert("삭제 처리를 위한 고유 식별자(ID)를 찾을 수 없습니다.");
        return;
    }
    
    if (!confirm("정말 이 신청 내역을 원본 기숙사 사이트에서 취소/삭제하시겠습니까?")) return;

    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');

    try {
        // Vercel 백엔드 API 서버에 삭제 대행 요청 위임
        const res = await fetch(`${BACKEND_API_URL}/api/delete-application`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': SASADOMI_API_KEY
            },
            body: JSON.stringify({
                studentId: currentStudentId,
                token: activeToken,
                type: type,        // 'study' 또는 'out' 전달
                del_items: id      // 학교 사이트 삭제 바디 규격명 매칭용 데이터
            })
        });

        const data = await res.json();
        if (data.success) {
            alert('신청 항목이 정상적으로 삭제되었습니다.');
            // 취소 반영 후 목록 리로드
            fetchApplications(currentStudentId, activeToken);
        } else {
            alert(data.message || '삭제에 실패했습니다.');
        }
    } catch (error) {
        console.error("삭제 요청 통신 에러:", error);
        alert("서버와 통신하는 중 에러가 발생했습니다.");
    }
}
