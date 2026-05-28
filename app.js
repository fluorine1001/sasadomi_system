// Render 또는 Vercel에 배포한 본인의 API 주소로 연동
const BACKEND_API_URL = 'https://sasadomi-system.vercel.app';

// 백엔드와 맞춘 API Key (Firebase Firestore의 developers 컬렉션 문서 ID와 매칭)
const SASADOMI_API_KEY = 'dev_abc123xyz'; 

let currentStudentId = '';
let currentSessionToken = ''; // 로그인 세션 토큰을 메모리에 안전하게 유지할 전역 변수

window.addEventListener('DOMContentLoaded', () => {
    // 🟢 화면 로드 시 서버에서 드롭다운 옵션들을 받아와 채워넣습니다.
    fetchOptions(); 

    const savedToken = localStorage.getItem('sasa_sessionToken');
    if (savedToken) {
        if (document.getElementById('rememberMe')) {
            document.getElementById('rememberMe').checked = true;
        }
        autoLogin(savedToken);
    }
});

// 📌 REST API v1: 메타데이터(드롭다운 옵션) 로드
async function fetchOptions() {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/meta/options`, {
            headers: { 'x-api-key': SASADOMI_API_KEY }
        });
        const data = await res.json();
        if (data.success) {
            populateSelect('studyTime', data.studyTimes);
            populateSelect('studyPlace', data.studyPlaces);
            populateSelect('studyDetail', data.teachers.map(t => ({value: t, label: t})));
            populateSelect('outBtime', data.outTimes.map(t => ({value: t, label: t})));
            populateSelect('outEtime', data.outTimes.map(t => ({value: t, label: t})));
        }
    } catch (error) { console.error("옵션 데이터 로드 실패", error); }
}

function populateSelect(id, optionsList) {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = '';
    optionsList.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        select.appendChild(option);
    });
}

// 📌 REST API v1: 상벌점 데이터 별도 호출
async function fetchPoints(studentId, token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/points?studentId=${studentId}&token=${token}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY }
        });
        
        const data = await res.json();
        if (data.success) {
            renderDashboard(data); 
        } else { console.error("상벌점 내역 조회 실패:", data.message); }
    } catch (error) { console.error("상벌점 내역 통신 오류:", error); }
}

// 📌 REST API v1: 자동 로그인
async function autoLogin(token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/auth/auto-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ token })
        });

        const data = await res.json();
        if (data.success) {
            currentStudentId = data.studentId;
            currentSessionToken = token;
            
            const loginForm = document.getElementById('loginForm');
            if (loginForm) loginForm.style.display = 'none';

            fetchPoints(currentStudentId, currentSessionToken);
            fetchApplications(currentStudentId, currentSessionToken);
        } else {
            clearSession();
        }
    } catch (error) { console.error('자동 로그인 실패:', error); }
}

// 📌 REST API v1: 최초 로그인 및 연동
async function syncAccount() {
    const rawStudentId = document.getElementById('studentId').value;
    const studentPw = document.getElementById('studentPw').value;

    if (!rawStudentId || !studentPw) return alert('아이디와 패스워드를 적어주세요.');

    const studentId = rawStudentId.trim().toLowerCase();
    if (studentId.length !== 11 || !studentId.startsWith('s')) {
        return alert('올바른 학번 양식(s년도학년반번호)으로 입력해 주세요.\n예: s2026030601');
    }

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            // 🟢 백엔드가 학번을 파싱하므로 프론트에서는 아이디와 비밀번호만 전송
            body: JSON.stringify({ studentId, studentPw }) 
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

            fetchPoints(currentStudentId, currentSessionToken);
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

// 📌 대시보드 UI 렌더링 (기존 로직 완벽 유지)
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

function clearSession() { localStorage.removeItem('sasa_sessionToken'); }

function toggleStudyFields(placeValue) {
    const conditionalBox = document.getElementById('conditionalStudyFields');
    if (placeValue === '3') conditionalBox.style.display = 'block';
    else conditionalBox.style.display = 'none';
}

// 📌 REST API v1: 자율학습 신청
async function submitStudy() {
    const rawDate = document.getElementById('studyDate').value;
    const time = document.getElementById('studyTime').value;
    const place = document.getElementById('studyPlace').value;
    
    if (!rawDate) return alert('날짜를 지정해 주세요.');
    const timestampSeconds = Math.floor(new Date(rawDate + 'T00:00:00').getTime() / 1000);
    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');

    const payload = { studentId: currentStudentId, token: activeToken, date: timestampSeconds, time: time, place: place };

    if (place === '3') {
        payload.detail = document.getElementById('studyDetail').value;
        payload.detail_reason = document.getElementById('studyDetailReason').value;
        if (!payload.detail_reason) return alert('본관 사유를 기록해 주세요.');
    }

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications/study`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
            alert('자율학습 신청 대행 요청이 처리되었습니다!');
            closeModal('studyModal');
            fetchApplications(currentStudentId, activeToken);
        } else { alert(data.message || '신청 실패'); }
    } catch (error) { alert('서버 통신 중 오류가 발생했습니다.'); }
}

// 📌 REST API v1: 외출/외박 신청
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
        const res = await fetch(`${BACKEND_API_URL}/v1/applications/out`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ studentId: currentStudentId, token: activeToken, type: outType, reason: outReason, bdate: bdateSec, edate: edateSec })
        });

        const data = await res.json();
        if (data.success) {
            alert('외출/외박 신청 연동 처리가 수락되었습니다.');
            closeModal('outModal');
            fetchApplications(currentStudentId, activeToken);
        } else { alert(data.message || '신청 실패'); }
    } catch (error) { alert('서버 통신 중 오류가 발생했습니다.'); }
}

// 📌 REST API v1: 연동 해제
async function disconnectAccount() {
    if (!currentStudentId) return alert('현재 연동된 계정이 없습니다.');
    if (!confirm('정말 계정 연동을 해제하시겠습니까?\n저장된 자동 로그인 정보가 즉시 삭제됩니다.')) return;

    const savedToken = localStorage.getItem('sasa_sessionToken');

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/auth/disconnect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ studentId: currentStudentId, token: savedToken })
        });

        const data = await res.json();
        if (data.success) {
            alert('계정 연동이 안전하게 해제되었습니다.');
            clearSession();
            currentStudentId = '';
            currentSessionToken = '';
            document.getElementById('dashboard').style.display = 'none';
            document.getElementById('loginForm').style.display = 'block';
            document.getElementById('studentId').value = '';
            document.getElementById('studentPw').value = '';
            if (document.getElementById('rememberMe')) document.getElementById('rememberMe').checked = false;
            document.getElementById('rewardView').innerText = '0';
            document.getElementById('penaltyView').innerText = '0';
            document.querySelector('#historyTable tbody').innerHTML = '';
            
            // 🟢 테이블 초기화 영역도 8열/6열 적용
            document.querySelector('#studyHistoryTable tbody').innerHTML = '<tr><td colspan="8" style="text-align:center;">내역을 불러오는 중...</td></tr>';
            document.querySelector('#outHistoryTable tbody').innerHTML = '<tr><td colspan="6" style="text-align:center;">내역을 불러오는 중...</td></tr>';
            closeModal('studyModal');
            closeModal('outModal');
        } else { alert(data.message || '연동 해제 실패'); }
    } catch (error) { alert('서버 통신 중 오류가 발생했습니다.'); }
}

function openModal(id) { document.getElementById(id).style.display = 'block'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }


// 📌 REST API v1: 신청 내역 조회 (GET 방식, 쿼리파라미터 사용)
async function fetchApplications(studentId, token) {
    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications?studentId=${studentId}&token=${token}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY }
        });
        
        const data = await res.json();
        if (data.success) {
            renderStudyList(data.studyList);
            renderOutList(data.outList);
        } else { console.error("신청 내역 조회 실패:", data.message); }
    } catch (error) { console.error("신청 내역 통신 오류:", error); }
}

function renderStudyList(list) {
    const tbody = document.querySelector('#studyHistoryTable tbody');
    tbody.innerHTML = '';
    
    if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#999;">신청 내역이 없습니다.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        const actionHtml = item.id 
            ? `<button onclick="deleteApplication('study', '${item.id}')" style="padding:3px 8px; background:#ff4d4f; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">취소</button>`
            : `<span style="color:#aaa; font-size:11px; font-weight:normal;">-</span>`;

        const tr = document.createElement('tr');
        if (item.id) tr.id = `row-study-${item.id}`; // 실시간 삭제를 위한 ID 부여

        // 🟢 8열 구조로 렌더링 (비어있는 값은 빈칸 유지)
        tr.innerHTML = `
            <td>${actionHtml}</td>
            <td>${item.date || ''}</td>
            <td>${item.time || ''}</td>
            <td>${item.place || ''}</td>
            <td>${item.teacher || ''}</td>
            <td>${item.detail || ''}</td>
            <td>${item.applyDate || ''}</td>
            <td><span class="status-badge">${item.status || ''}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

function renderOutList(list) {
    const tbody = document.querySelector('#outHistoryTable tbody');
    tbody.innerHTML = '';
    
    if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#999;">신청 내역이 없습니다.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        const actionHtml = item.id 
            ? `<button onclick="deleteApplication('out', '${item.id}')" style="padding:3px 8px; background:#ff4d4f; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">취소</button>`
            : `<span style="color:#999; font-size:11px; font-style:italic;">-</span>`;

        const tr = document.createElement('tr');
        if (item.id) tr.id = `row-out-${item.id}`;

        // 🟢 6열 구조로 렌더링
        tr.innerHTML = `
            <td>${actionHtml}</td>
            <td><strong>${item.type || ''}</strong></td>
            <td>${item.reason || ''}</td>
            <td>${item.outDate || ''}</td>
            <td>${item.inDate || ''}</td>
            <td><span class="status-badge">${item.status || ''}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

// 📌 REST API v1: 취소/삭제 대행 (DELETE 방식, 실시간 UI 제거 적용)
async function deleteApplication(type, id) {
    if (!id || id === 'undefined' || id === '') {
        alert("이 항목은 학교 시스템상 이미 확정되어 원격 취소/삭제가 불가능합니다.");
        return;
    }
    if (!confirm("정말 이 신청 내역을 원본 기숙사 사이트에서 취소/삭제하시겠습니까?")) return;

    const activeToken = currentSessionToken || localStorage.getItem('sasa_sessionToken');

    try {
        const res = await fetch(`${BACKEND_API_URL}/v1/applications/${type}/${id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-api-key': SASADOMI_API_KEY },
            body: JSON.stringify({ studentId: currentStudentId, token: activeToken })
        });

        const data = await res.json();
        if (data.success) {
            alert('신청 항목이 성공적으로 삭제/취소 처리되었습니다.');
            
            // 🟢 [낙관적 업데이트] 화면에서 해당 줄 바로 삭제
            const rowElement = document.getElementById(`row-${type}-${id}`);
            if (rowElement) rowElement.remove();

            const isStudy = type === 'study';
            const tableId = isStudy ? '#studyHistoryTable tbody' : '#outHistoryTable tbody';
            const colSpan = isStudy ? 8 : 6;

            const tbody = document.querySelector(tableId);
            if (tbody && tbody.children.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center; color:#999;">신청 내역이 없습니다.</td></tr>`;
            }

            // DB 싱크를 맞추기 위해 1초 뒤 조용히 백그라운드 새로고침
            setTimeout(() => { fetchApplications(currentStudentId, activeToken); }, 1000);
        } else {
            alert(data.message || '삭제 실패');
        }
    } catch (error) {
        console.error("삭제 요청 통신 에러:", error);
        alert("서버와 통신하는 중 오류가 발생했습니다.");
    }
}
